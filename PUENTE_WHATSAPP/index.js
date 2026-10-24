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
           `*4.* Horarios y ubicación del hospital\n` +
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
            // ============ SALIR ============
            if (texto === '9' || texto === 'salir') {
                sesiones.delete(from);
                await responder(from, 'Gracias por usar el sistema. ¡Hasta luego!');
                return;
            }

            // ============ MENU ============
            if (['hola', 'buen dia', 'buenas', 'inicio', 'menu'].includes(texto)) {
                sesiones.delete(from);
                await responder(from, menuPrincipal());
                return;
            }

            const sesion = sesiones.get(from);

            // ============ FLUJO SACAR TURNO ============
            
            // Paso 1: Pidió DNI para sacar turno
            if (sesion && sesion.paso === 'sacar_dni') {
                if (!/^\d{7,9}$/.test(texto)) {
                    await responder(from, 'El DNI debe tener entre 7 y 9 números. Escribí tu DNI nuevamente o *9* para salir.');
                    return;
                }
                
                try {
                    const res = await axios.get(`${BACKEND}/turnos/por-dni/${texto}`);
                    
                    if (res.data.encontrado === false) {
                        sesiones.set(from, { paso: 'sacar_registro_nombre', dni: texto });
                        await responder(from, 
                            `No encontramos un paciente con DNI *${texto}*.\n\n` +
                            `Para registrarte, escribí tu *Nombre y Apellido* (ej: Juan Pérez).\n` +
                            `O escribí *no* para cancelar.`);
                    } else {
                        sesiones.set(from, { paso: 'sacar_especialidad', dni: texto, paciente_id: res.data.paciente_id || null });
                        await pedirEspecialidadParaTurno(from, texto);
                    }
                } catch (error) {
                    await responder(from, 'Error al consultar el sistema. Escribí *9* para salir.');
                }
                return;
            }

            // Paso 2: Está registrando nombre de paciente nuevo
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
                    sesiones.set(from, { paso: 'sacar_especialidad', dni: dni, paciente_id: pacienteId });
                    
                    await responder(from, `✅ Registro exitoso. Bienvenido/a, *${nombre}*.`);
                    await pedirEspecialidadParaTurno(from, dni);
                } catch (error) {
                    console.error('❌ Error al registrar:', error.response ? error.response.data : error.message);
                    await responder(from, 'Error al registrar. Escribí *9* para salir.');
                    sesiones.delete(from);
                }
                return;
            }

            // Paso 3: Eligió especialidad, mostrar horarios
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
                    
                    // Guardar los horarios para cuando elija
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

            // Paso 4: Eligió un número de horario, confirmar turno
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
                            fecha: horarioElegido.fecha_hora  // Usamos fecha_hora (formato interno) para guardar en BD
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

            // ============ FLUJO VER MIS TURNOS ============
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

            // ============ DNI DIRECTO ============
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

            // ============ MENU NUMÉRICO ============
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
                await responder(from, 
                    'Para *cancelar un turno*, acercate al hospital o llamá a Mesa de Entradas.\n\n' +
                    '📞 Teléfono: (381) 400-0000\n' +
                    '🕐 Horario: lunes a viernes de 7:00 a 13:00 hs.\n\n' +
                    'Escribí *menu* para ver las opciones o *9* para salir.');
                return;
            }
            
            if (texto === '4') {
                await responder(from, 
                    `*${NOMBRE_HOSPITAL}*\n\n` +
                    `📍 *Dirección:*\n` +
                    `Av. San Martín 123, Tafí del Valle\n\n` +
                    `🕐 *Horarios de atención:*\n` +
                    `Lunes a viernes: 7:00 a 19:00 hs\n` +
                    `Sábados: 8:00 a 12:00 hs\n\n` +
                    `📞 *Teléfono:*\n` +
                    `(381) 400-0000\n\n` +
                    `🚑 *Emergencias:*\n` +
                    `Llamá al 107 (gratuito)\n\n` +
                    `Escribí *menu* para ver las opciones o *9* para salir.`);
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

            // ============ RESPUESTA POR DEFECTO ============
            await responder(from, 'No entendí la opción. Escribí *menu* para ver las opciones o *9* para salir.');

        } catch (error) {
            console.error('❌ Error:', error.message);
            await responder(from, 'Ocurrió un error. Escribí *9* para salir.');
        }
    });
}

// Función auxiliar para pedir especialidad
async function pedirEspecialidadParaTurno(jid, dni) {
    try {
        const res = await axios.get(`${BACKEND}/medicos/especialidades`);
        const esp = res.data.especialidades || [];
        let msg = `✅ DNI *${dni}* reconocido.\n\n*Especialidades disponibles:*\n`;
        esp.forEach((e, i) => msg += `${i+1}. ${e}\n`);
        msg += '\nEscribí el *numero de la especialidad* que necesitás.';
        await responder(jid, msg);
    } catch (error) {
        await responder(jid, `✅ DNI *${dni}* reconocido.\n\nEscribí la *especialidad* que necesitás (ej: Cardiología).`);
    }
}

// API para que Python pueda enviar mensajes
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