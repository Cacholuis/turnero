require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const port = Number(process.env.PORT || 3000);
const BACKEND = process.env.BACKEND_PYTHON_URL || 'http://localhost:8000';
const NOMBRE_HOSPITAL = 'Hospital Público Tafí del Valle';

const app = express();
app.use(express.json({ limit: '16kb' }));

let sock = null;
let isBotReady = false;
const sesiones = new Map();

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const humanDelay = () => delay(Math.floor(Math.random() * 1000) + 500);

async function responder(jid, texto) {
    await humanDelay();
    await sock.sendMessage(jid, { text: texto });
}

function menuPrincipal() {
    return `*Bienvenido al ${NOMBRE_HOSPITAL}*\n\n` +
           `Elija una opción escribiendo el número:\n\n` +
           `*1.* Sacar un turno nuevo\n` +
           `*2.* Ver mis turnos\n` +
           `*3.* Cancelar un turno\n` +
           `*4.* Comunicarse con Emergencias\n` +
           `*5.* Ver especialidades\n` +
           `*9.* Salir`;
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('\n📱 Escanea este código QR con el celular del hospital:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const debeReconectar = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut : true;
            if (debeReconectar) connectToWhatsApp();
        } else if (connection === 'open') {
            isBotReady = true;
            console.log('✅ ¡WhatsApp listo y conectado!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;
        const msg = messages[0];
        if (!msg || !msg.message || msg.key.fromMe) return;
        
        const from = msg.key.remoteJid;
        if (!from || (!from.endsWith('@s.whatsapp.net') && !from.endsWith('@lid'))) return;

        const messageType = Object.keys(msg.message)[0];
        const textoOriginal = messageType === 'conversation' ? msg.message.conversation : msg.message.extendedTextMessage?.text;
        if (!textoOriginal) return;

        const texto = textoOriginal.trim().toLowerCase();
        console.log(`📩 Mensaje: "${texto}"`);

        try {
            const sesion = sesiones.get(from);

            // ============================================================
            // MODO ADMINISTRADOR SECRETO
            // ============================================================
            
            // 1. Activar modo admin
            if (texto === 'admin' || texto === 'administrador') {
                if (sesion && sesion.rol === 'admin') {
                    await responder(from, 'Ya estás en modo administrador. Usá los comandos del menú.');
                    return;
                }
                sesiones.set(from, { paso: 'admin_auth', rol: 'pendiente' });
                await responder(from, '🔐 *MODO ADMINISTRADOR*\n\nIngresá la *clave de acceso* para continuar:\n*(Escribí 9 para cancelar)*');
                return;
            }

            // 2. Validar clave de admin
            if (sesion && sesion.paso === 'admin_auth') {
                if (texto === '9' || texto === 'salir') {
                    sesiones.delete(from);
                    await responder(from, 'Acceso cancelado.');
                    return;
                }
                if (texto === process.env.ADMIN_PASSWORD) {
                    sesiones.set(from, { paso: 'admin_menu', rol: 'admin' });
                    await responder(from, 
                        '✅ *Acceso concedido*\n\n' +
                        '*MENÚ DE ADMINISTRADOR:*\n\n' +
                        '*1.* 📅 Ver listado de turnos\n' +
                        '*2.* 👨‍⚕️ Agregar nuevo médico\n' +
                        '*3.* 🕐 Agregar horario a médico\n' +
                        '*4.* 📊 Exportar todos los turnos a Excel\n' +
                        '*9.* Salir del modo administrador'
                    );
                    return;
                } else {
                    await responder(from, '❌ Clave incorrecta. Acceso denegado.');
                    sesiones.delete(from);
                    return;
                }
            }

            // 3. Acciones del Administrador (solo si rol === 'admin')
            if (sesion && sesion.rol === 'admin') {
                if (texto === '9' || texto === 'salir') {
                    sesiones.delete(from);
                    await responder(from, 'Sesión de administrador cerrada. ¡Hasta luego!');
                    return;
                }

                if (texto === '1') {
                    await responder(from, '⏳ Consultando turnos...');
                    try {
                        const res = await axios.get(`${BACKEND}/admin/turnos-detallados`);
                        const turnos = res.data;
                        if (turnos.length === 0) {
                            await responder(from, 'No hay turnos registrados en el sistema.');
                        } else {
                            const ultimos = turnos.slice(0, 10);
                            let msg = `📅 *ÚLTIMOS 10 TURNOS REGISTRADOS:*\n\n`;
                            ultimos.forEach(t => {
                                msg += `🔹 *${t.fecha}* | ${t.paciente} (DNI: ${t.dni})\n   👨‍⚕️ ${t.medico} - ${t.especialidad}\n\n`;
                            });
                            msg += `(Total en sistema: ${turnos.length} turnos. Usá la opción 4 para el listado completo).`;
                            await responder(from, msg);
                        }
                    } catch (error) {
                        await responder(from, '❌ Error al consultar los turnos.');
                    }
                    return;
                }

                if (texto === '2') {
                    sesiones.set(from, { ...sesion, paso: 'admin_add_medico' });
                    await responder(from, 
                        '👨‍⚕️ *AGREGAR MÉDICO*\n\n' +
                        'Escribí el nombre y la especialidad separados por una coma.\n' +
                        '*Ejemplo:* Dr. Juan Perez, Cardiologia\n\n' +
                        'Escribí *9* para cancelar.'
                    );
                    return;
                }

                if (sesion.paso === 'admin_add_medico') {
                    if (texto === '9' || texto === 'salir') {
                        sesiones.set(from, { paso: 'admin_menu', rol: 'admin' });
                        await responder(from, 'Operación cancelada. Volviendo al menú.');
                        return;
                    }
                    const partes = textoOriginal.split(',');
                    if (partes.length < 2) {
                        await responder(from, '❌ Formato incorrecto. Usá: Nombre, Especialidad');
                        return;
                    }
                    try {
                        await axios.post(`${BACKEND}/admin/medicos`, {
                            nombre: partes[0].trim(),
                            especialidad: partes[1].trim()
                        });
                        sesiones.set(from, { paso: 'admin_menu', rol: 'admin' });
                        await responder(from, `✅ Médico *${partes[0].trim()}* agregado correctamente.`);
                    } catch (error) {
                        await responder(from, '❌ Error al agregar el médico.');
                    }
                    return;
                }

                if (texto === '3') {
                    try {
                        const res = await axios.get(`${BACKEND}/admin/medicos-lista`);
                        const medicos = res.data;
                        let msg = '🕐 *AGREGAR HORARIO*\n\nPrimero, elegí el ID del médico:\n\n';
                        medicos.forEach(m => {
                            msg += `*${m.id}.* ${m.nombre} (${m.especialidad})\n`;
                        });
                        msg += '\nEscribí el *número de ID* del médico (o *9* para cancelar).';
                        sesiones.set(from, { ...sesion, paso: 'admin_add_horario_id', medicos_lista: medicos });
                        await responder(from, msg);
                    } catch (error) {
                        await responder(from, '❌ Error al cargar la lista de médicos.');
                    }
                    return;
                }

                if (sesion.paso === 'admin_add_horario_id') {
                    if (texto === '9' || texto === 'salir') {
                        sesiones.set(from, { paso: 'admin_menu', rol: 'admin' });
                        return;
                    }
                    const idMedico = parseInt(texto);
                    const medico = sesion.medicos_lista.find(m => m.id === idMedico);
                    if (!medico) {
                        await responder(from, '❌ ID inválido. Escribí el número correcto o *9* para cancelar.');
                        return;
                    }
                    sesiones.set(from, { 
                        ...sesion, 
                        paso: 'admin_add_horario_datos', 
                        medico_seleccionado: medico 
                    });
                    await responder(from, 
                        `Elegiste a: *${medico.nombre}*\n\n` +
                        `Ahora escribí el *día y la hora* separados por coma.\n` +
                        `Días válidos: lunes, martes, miercoles, jueves, viernes, sabado.\n` +
                        `*Ejemplo:* lunes, 08:00\n\n` +
                        `Escribí *9* para cancelar.`
                    );
                    return;
                }

                if (sesion.paso === 'admin_add_horario_datos') {
                    if (texto === '9' || texto === 'salir') {
                        sesiones.set(from, { paso: 'admin_menu', rol: 'admin' });
                        return;
                    }
                    const partes = texto.split(',');
                    if (partes.length < 2) {
                        await responder(from, '❌ Formato incorrecto. Usá: dia, hora (ej: lunes, 08:00)');
                        return;
                    }
                    try {
                        await axios.post(`${BACKEND}/admin/horarios`, {
                            medico_id: sesion.medico_seleccionado.id,
                            dia_semana: partes[0].trim().toLowerCase(),
                            hora: partes[1].trim() + ":00"
                        });
                        sesiones.set(from, { paso: 'admin_menu', rol: 'admin' });
                        await responder(from, `✅ Horario agregado correctamente para *${sesion.medico_seleccionado.nombre}*.`);
                    } catch (error) {
                        await responder(from, '❌ Error al agregar el horario. Verificá que el día esté bien escrito.');
                    }
                    return;
                }

                if (texto === '4') {
                    await responder(from, '⏳ Generando archivo Excel...');
                    try {
                        const res = await axios.get(`${BACKEND}/admin/turnos-detallados`);
                        const turnos = res.data;
                        
                        let csv = "ID,Paciente,DNI,Medico,Especialidad,Fecha\n";
                        turnos.forEach(t => {
                            csv += `${t.id},"${t.paciente}",${t.dni},"${t.medico}","${t.especialidad}","${t.fecha}"\n`;
                        });

                        await sock.sendMessage(from, {
                            document: Buffer.from(csv, 'utf-8'),
                            mimetype: 'text/csv',
                            fileName: `Turnos_Hospital_${new Date().toISOString().split('T')[0]}.csv`,
                            caption: `📊 *Listado completo de turnos*\n\nTotal de registros: ${turnos.length}\n\nPodés abrir este archivo directamente con Excel.`
                        });
                        
                        sesiones.set(from, { paso: 'admin_menu', rol: 'admin' });
                    } catch (error) {
                        console.error('Error al exportar:', error);
                        await responder(from, '❌ Error al generar el archivo.');
                    }
                    return;
                }
            }
            // ============================================================
            // FIN DEL MODO ADMINISTRADOR
            // ============================================================

            // ============ SALIR ============
            if (texto === '9' || texto === 'salir') {
                sesiones.delete(from);
                await responder(from, 'Gracias por usar el sistema. ¡Hasta luego!');
                return;
            }

            // ============ MENU ============
            if (['hola', 'buen dia', 'buenas', 'inicio', 'menu', 'turnos', 'turno', 'citas', 'cita'].includes(texto)) {
                sesiones.delete(from);
                await responder(from, menuPrincipal());
                return;
            }

            // ============ FLUJO SACAR TURNO ============
            if (sesion && sesion.paso === 'sacar_dni') {
                if (!/^\d{7,9}$/.test(texto)) {
                    await responder(from, 'El DNI debe tener entre 7 y 9 números. Escribí tu DNI nuevamente o *9* para salir.');
                    return;
                }
                try {
                    const res = await axios.get(`${BACKEND}/turnos/por-dni/${texto}`);
                    if (res.data.encontrado === false) {
                        sesiones.set(from, { paso: 'sacar_registro_nombre', dni: texto });
                        await responder(from, `No encontramos un paciente con DNI *${texto}*.\n\nPara registrarte, escribí tu *Nombre y Apellido* (ej: Juan Pérez).\nO escribí *no* para cancelar.`);
                    } else {
                        sesiones.set(from, { paso: 'sacar_especialidad', dni: texto, paciente_id: res.data.paciente_id || null });
                        await pedirEspecialidadParaTurno(from, texto);
                    }
                } catch (error) {
                    await responder(from, 'Error al consultar el sistema. Escribí *9* para salir.');
                }
                return;
            }

            if (sesion && sesion.paso === 'sacar_registro_nombre') {
                if (texto === 'no' || texto === 'cancelar') {
                    sesiones.delete(from);
                    await responder(from, 'Registro cancelado. Escribí *menu* para ver las opciones.');
                    return;
                }
                const dni = sesion.dni;
                const nombre = textoOriginal.trim();
                try {
                    const res = await axios.post(`${BACKEND}/pacientes/`, {
                        nombre: nombre,
                        dni: dni
                    });
                    const pacienteId = res.data.paciente.id;
                    const numeroReal = from.replace(/\D/g, '');
                    sesiones.set(from, { 
                        paso: 'sacar_especialidad', 
                        dni: dni, 
                        paciente_id: pacienteId,
                        telefono_real: numeroReal
                    });
                    await responder(from, `✅ Registro exitoso. Bienvenido/a, *${nombre}*.`);
                    await pedirEspecialidadParaTurno(from, dni);
                } catch (error) {
                    console.error('❌ Error al registrar:', error.response ? error.response.data : error.message);
                    await responder(from, 'Error al registrar. Escribí *9* para salir.');
                    sesiones.delete(from);
                }
                return;
            }

            if (sesion && sesion.paso === 'sacar_especialidad') {
                const dni = sesion.dni;
                const pacienteId = sesion.paciente_id;
                const especialidad = textoOriginal.trim();
                try {
                    let pId = pacienteId;
                    if (!pId) {
                        const resPac = await axios.get(`${BACKEND}/turnos/por-dni/${dni}`);
                        pId = resPac.data.paciente_id;
                    }
                    const res = await axios.get(`${BACKEND}/turnos/disponibles/${encodeURIComponent(especialidad)}`);
                    if (res.data.encontrado === false) {
                        await responder(from, res.data.mensaje + '\n\nEscribí *menu* para ver las opciones.');
                        sesiones.delete(from);
                        return;
                    }
                    sesiones.set(from, { 
                        paso: 'sacar_elegir_horario', 
                        dni: dni, 
                        paciente_id: pId,
                        horarios: res.data.horarios,
                        especialidad: especialidad
                    });
                    await responder(from, res.data.mensaje);
                } catch (error) {
                    console.error('Error:', error.message);
                    await responder(from, 'Error al buscar turnos. Escribí *9* para salir.');
                    sesiones.delete(from);
                }
                return;
            }

            if (sesion && sesion.paso === 'sacar_elegir_horario') {
                const numero = parseInt(texto);
                const horarios = sesion.horarios;
                if (isNaN(numero) || numero < 1 || numero > horarios.length) {
                    await responder(from, `Escribí un número entre 1 y ${horarios.length}, o *9* para salir.`);
                    return;
                }
                const horarioElegido = horarios[numero - 1];
                try {
                    const res = await axios.post(`${BACKEND}/turnos/reservar`, null, {
                        params: {
                            paciente_id: sesion.paciente_id,
                            medico_id: horarioElegido.medico_id,
                            fecha: horarioElegido.fecha_hora
                        }
                    });
                    sesiones.delete(from);
                    if (res.data.ok) {
                        await responder(from, res.data.mensaje);
                        await responder(from, 'Escribí *menu* para ver las opciones o *9* para salir.');
                    } else {
                        await responder(from, res.data.mensaje);
                    }
                } catch (error) {
                    await responder(from, 'Error al reservar el turno. Escribí *9* para salir.');
                    sesiones.delete(from);
                }
                return;
            }

            if (sesion && sesion.paso === 'ver_dni') {
                if (!/^\d{7,9}$/.test(texto)) {
                    await responder(from, 'El DNI debe tener entre 7 y 9 números. Escribí *9* para salir.');
                    return;
                }
                try {
                    const res = await axios.get(`${BACKEND}/turnos/por-dni/${texto}`);
                    await responder(from, res.data.mensaje);
                    await responder(from, 'Escribí *menu* para ver las opciones o *9* para salir.');
                } catch (error) {
                    await responder(from, 'Error al consultar. Escribí *9* para salir.');
                }
                sesiones.delete(from);
                return;
            }

            if (/^\d{7,9}$/.test(texto) && !sesion) {
                try {
                    const res = await axios.get(`${BACKEND}/turnos/por-dni/${texto}`);
                    if (res.data.encontrado === false) {
                        sesiones.set(from, { paso: 'sacar_registro_nombre', dni: texto });
                        await responder(from, `No encontramos un paciente con DNI *${texto}*.\n\nPara registrarte, escribí tu *Nombre y Apellido* (ej: Juan Pérez).\nO escribí *no* para cancelar.`);
                    } else {
                        sesiones.set(from, { paso: 'sacar_especialidad', dni: texto, paciente_id: res.data.paciente_id || null });
                        await pedirEspecialidadParaTurno(from, texto);
                    }
                } catch (error) {
                    await responder(from, 'Error al consultar el sistema. Escribí *9* para salir.');
                }
                return;
            }

            if (texto === '1') {
                sesiones.set(from, { paso: 'sacar_dni' });
                await responder(from, '🆔 Escribí tu número de *DNI* (solo números):');
                return;
            }
            
            if (texto === '2') {
                sesiones.set(from, { paso: 'ver_dni' });
                await responder(from, '🆔 Escribí tu número de *DNI* (solo números):');
                return;
            }
            
            if (texto === '3') {
                await responder(from, 'Para *cancelar un turno*, acercate al hospital o llamá a Mesa de Entradas.\n\n📞 Teléfono: (381) 400-0000\n🕐 Horario: lunes a viernes de 7:00 a 13:00 hs.\n\nEscribí *menu* para ver las opciones o *9* para salir.');
                return;
            }
            
            // ============ EMERGENCIA: Opción 4 ============
            if (texto === '4') {
                let numeroPaciente = (sesion && sesion.telefono_real) ? sesion.telefono_real : from.replace(/\D/g, '');

                if (numeroPaciente.length > 15 || (!numeroPaciente.startsWith('54') && !numeroPaciente.startsWith('381'))) {
                    sesiones.set(from, { ...sesion, paso: 'emergencia_pedir_telefono' });
                    await responder(from, 
                        `🚨 *SOLICITUD DE EMERGENCIA*\n\n` +
                        `Para que el personal del hospital pueda contactarte, por favor respondé a este mensaje con tu *número de teléfono* (solo números, ej: 3816542126).`
                    );
                    return;
                }
                await enviarAlertaEmergencia(from, sesion, numeroPaciente, msg);
                return;
            }

            if (sesion && sesion.paso === 'emergencia_pedir_telefono') {
                const numeroIngresado = texto.replace(/\D/g, '');
                if (numeroIngresado.length < 8) {
                    await responder(from, 'El número parece incompleto. Por favor escribí tu número de teléfono correctamente (ej: 3816542126).');
                    return;
                }
                sesiones.set(from, { ...sesion, telefono_real: numeroIngresado, paso: null });
                await enviarAlertaEmergencia(from, sesion, numeroIngresado, msg);
                return;
            }

            if (texto === '5') {
                try {
                    const res = await axios.get(`${BACKEND}/medicos/especialidades`);
                    const esp = res.data.especialidades || [];
                    let msg = '*Especialidades disponibles:*\n\n';
                    esp.forEach((e, i) => msg += `${i+1}. ${e}\n`);
                    msg += '\nEscribí *menu* para ver las opciones o *9* para salir.';
                    await responder(from, msg);
                } catch (e) {
                    await responder(from, 'No se pudieron cargar las especialidades. Escribí *9* para salir.');
                }
                return;
            }

            await responder(from, 'No entendí la opción. Escribí *menu* para ver las opciones o *9* para salir.');

        } catch (error) {
            console.error('❌ Error:', error.message);
            await responder(from, 'Ocurrió un error. Escribí *9* para salir.');
        }
    });
}

async function enviarAlertaEmergencia(from, sesion, numeroPaciente, msg) {
    try {
        const numeroEmergenciaRaw = process.env.EMERGENCIA_WHATSAPP || '';
        const numeroEmergencia = numeroEmergenciaRaw.replace(/\D/g, '');

        console.log('\n========================================');
        console.log('🔍 DEBUG EMERGENCIA:');
        console.log('📱 Teléfono del paciente:', numeroPaciente);
        console.log('🏥 Teléfono del hospital:', numeroEmergencia);
        console.log('========================================\n');

        const nombrePaciente = msg.pushName || 'Paciente';
        const fechaHora = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Tucuman' });

        const mensajeAlerta = 
            `🚨 *SOLICITUD DE ATENCIÓN URGENTE*\n\n` +
            `Un paciente solicitó contacto urgente desde el bot.\n\n` +
            `👤 *Paciente:* ${nombrePaciente}\n` +
            `📞 *Teléfono:* ${numeroPaciente}\n` +
            `🕐 *Fecha:* ${fechaHora}\n\n` +
            `⚠️ Por favor, comunicarse con el paciente a la brevedad.`;

        const resultado = await sock.onWhatsApp(`${numeroEmergencia}@s.whatsapp.net`);

        if (!resultado || !resultado[0] || !resultado[0].exists) {
            console.error(`❌ El número de emergencia ${numeroEmergencia} NO tiene WhatsApp.`);
            await responder(from, '❌ No se pudo contactar al hospital. Llame al 107.');
            return;
        }

        await sock.sendMessage(resultado[0].jid, { text: mensajeAlerta });
        console.log(`✅ Alerta enviada con éxito al hospital.`);

        await responder(from, 
            `✅ *Aviso enviado al hospital*\n\n` +
            `El personal se comunicará con usted al número *${numeroPaciente}* a la brevedad.\n\n` +
            `⚠️ Si es una emergencia médica, llame al *107* o acuda a guardia.`
        );

    } catch (error) {
        console.error('❌ Error crítico en emergencia:', error);
        await responder(from, '❌ No se pudo procesar su solicitud. Llame al 107.');
    }
}

async function pedirEspecialidadParaTurno(jid, dni) {
    try {
        const res = await axios.get(`${BACKEND}/medicos/especialidades`);
        const esp = res.data.especialidades || [];
        let msg = `✅ DNI *${dni}* reconocido.\n\n*Especialidades disponibles:*\n`;
        esp.forEach((e, i) => msg += `${i+1}. ${e}\n`);
        msg += '\nEscribí el *nombre o el número* de la especialidad que necesitás.';
        await responder(jid, msg);
    } catch (error) {
        await responder(jid, `✅ DNI *${dni}* reconocido.\n\nEscribí la *especialidad* que necesitás (ej: Cardiología).`);
    }
}

app.post('/send', async (req, res) => {
    const { telefono, mensaje } = req.body || {};
    if (!telefono || !mensaje || !isBotReady) {
        return res.status(400).json({ error: 'Datos inválidos' });
    }
    try {
        const digits = String(telefono).replace(/[\s()+.-]/g, '');
        await humanDelay();
        await sock.sendMessage(`${digits}@s.whatsapp.net`, { text: mensaje.trim() });
        return res.status(200).json({ ok: true });
    } catch (error) {
        return res.status(502).json({ error: 'Fallo al enviar' });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Servidor en puerto: ${port}`);
    connectToWhatsApp();
});