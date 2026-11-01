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

async function mostrarMenuAdmin(from) {
    await responder(from, 
        '*MENÚ DE ADMINISTRADOR:*\n\n' +
        '*1.* 📅 Ver listado de turnos\n' +
        '*2.* 👨‍⚕️ Agregar nuevo médico\n' +
        '*3.* 🕐 Agregar horario a médico\n' +
        '*4.* 📊 Exportar turnos a Excel\n' +
        '*5.* ❌ Eliminar médico (con transferencia)\n' +
        '*6.* ✏️ Modificar horario de médico\n' +
        '*7.* 📝 Modificar datos del médico\n' +
        '*8.* 🗑️ Eliminar horario específico\n' +
        '*9.* Salir del modo administrador\n' +
        '*10.* 🔑 Gestionar contraseñas de médicos'
    );
}

async function mostrarMenuMedico(from, nombreMedico) {
    await responder(from, 
        `*MENÚ DEL MÉDICO*\n` +
        `Dr. ${nombreMedico}\n\n` +
        `*1.* 📅 Ver mi agenda de hoy\n` +
        `*2.* 📋 Ver todos mis turnos\n` +
        `*3.* 📊 Exportar mi agenda a Excel\n` +
        `*4.* 🔑 Cambiar mi contraseña\n` +
        `*5.* 🚪 Salir`
    );
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    sock = makeWASocket({ auth: state, printQRInTerminal: true, logger: pino({ level: 'silent' }) });
    
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { console.log('\n📱 Escanea este código QR con el celular del hospital:'); qrcode.generate(qr, { small: true }); }
        if (connection === 'close') {
            const debeReconectar = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut : true;
            if (debeReconectar) connectToWhatsApp();
        } else if (connection === 'open') { isBotReady = true; console.log('✅ ¡WhatsApp listo y conectado!'); }
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
            // MENÚ DEL MÉDICO
            // ============================================================
            if (texto === 'medico' || texto === 'mimedico') {
                sesiones.set(from, { paso: 'medico_auth_id' });
                await responder(from, '👨‍⚕️ *MENÚ DEL MÉDICO*\n\nPor favor, escribí tu *ID de médico*:\n(Si no lo sabés, contactá a administración)\n\nEscribí *9* para cancelar.');
                return;
            }
            if (sesion && sesion.paso === 'medico_auth_id') {
                if (texto === '9' || texto === 'salir') { sesiones.delete(from); await responder(from, 'Operación cancelada.'); return; }
                const idMedico = parseInt(texto);
                if (isNaN(idMedico)) { await responder(from, '❌ ID inválido. Escribí solo números o *9* para cancelar.'); return; }
                sesiones.set(from, { paso: 'medico_auth_password', medico_id: idMedico });
                await responder(from, '🔐 *VERIFICACIÓN*\n\nAhora escribí tu *contraseña*:\n(Si no la tenés, contactá a administración)\n\nEscribí *9* para cancelar.');
                return;
            }
            if (sesion && sesion.paso === 'medico_auth_password') {
                if (texto === '9' || texto === 'salir') { sesiones.delete(from); await responder(from, 'Operación cancelada.'); return; }
                const password = textoOriginal.trim();
                const idMedico = sesion.medico_id;
                try {
                    const res = await axios.post(`${BACKEND}/medicos/${idMedico}/verificar-credencial`, null, { params: { password: password } });
                    if (!res.data.ok) { sesiones.delete(from); await responder(from, '❌ ID o contraseña incorrectos.\n\nEscribí *medico* para intentar de nuevo.'); return; }
                    const medicosRes = await axios.get(`${BACKEND}/medicos/`);
                    const medico = medicosRes.data.find(m => m.id === idMedico);
                    if (!medico) { sesiones.delete(from); await responder(from, '❌ Error al cargar datos del médico.'); return; }
                    sesiones.set(from, { paso: 'medico_menu', medico_id: idMedico, password_actual: password, nombre_medico: medico.nombre, especialidad_medico: medico.especialidad });
                    await mostrarMenuMedico(from, medico.nombre);
                } catch (error) { sesiones.delete(from); await responder(from, '❌ Error al verificar credencial.\n\nEscribí *medico* para intentar de nuevo.'); }
                return;
            }
            if (sesion && sesion.paso === 'medico_menu') {
                if (texto === '5' || texto === '9' || texto === 'salir') { sesiones.delete(from); await responder(from, '✅ ¡Que tengas buen día, Dr.!'); return; }
                
                if (texto === '1') {
                    try {
                        const agendaRes = await axios.get(`${BACKEND}/medicos/${sesion.medico_id}/agenda`);
                        const agenda = agendaRes.data;
                        if (agenda.turnos.length === 0) {
                            await responder(from, `📋 *AGENDA DE HOY*\n\nDr. ${agenda.medico}\n${agenda.especialidad}\nFecha: ${new Date().toLocaleDateString('es-AR')}\n\n✅ No tenés turnos programados para hoy.`);
                        } else {
                            let msg = `📋 *AGENDA DE HOY*\n\n👨‍⚕️ Dr. ${agenda.medico}\n🏥 ${agenda.especialidad}\n📅 ${new Date().toLocaleDateString('es-AR')}\n\n*Total de pacientes: ${agenda.turnos.length}*\n\n`;
                            agenda.turnos.forEach(t => { msg += `🔹 *${t.hora}* - ${t.paciente} (DNI: ${t.dni})\n`; });
                            await responder(from, msg);
                        }
                        await mostrarMenuMedico(from, sesion.nombre_medico);
                    } catch (error) { await responder(from, '❌ Error al cargar la agenda.'); await mostrarMenuMedico(from, sesion.nombre_medico); }
                    return;
                }
                if (texto === '2') {
                    try {
                        const res = await axios.get(`${BACKEND}/medicos/${sesion.medico_id}/turnos`);
                        const turnos = res.data.turnos;
                        if (turnos.length === 0) { await responder(from, '📋 No tenés turnos programados próximamente.'); } 
                        else {
                            let msg = `📋 *TODOS MIS TURNOS*\n\nDr. ${res.data.medico}\n${res.data.especialidad}\n\n*Total: ${turnos.length} turnos*\n\n`;
                            turnos.forEach(t => { msg += `🔹 *${t.fecha}* - ${t.paciente} (DNI: ${t.dni})\n`; });
                            await responder(from, msg);
                        }
                        await mostrarMenuMedico(from, sesion.nombre_medico);
                    } catch (error) { await responder(from, '❌ Error al cargar los turnos.'); await mostrarMenuMedico(from, sesion.nombre_medico); }
                    return;
                }
                if (texto === '3') {
                    await responder(from, '⏳ Generando archivo Excel...');
                    try {
                        const agendaRes = await axios.get(`${BACKEND}/medicos/${sesion.medico_id}/agenda`);
                        const agenda = agendaRes.data;
                        let csv = "Hora,Paciente,DNI\n";
                        agenda.turnos.forEach(t => { csv += `${t.hora},"${t.paciente}",${t.dni}\n`; });
                        const nombreArchivo = `Agenda_${agenda.medico.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`;
                        await sock.sendMessage(from, {
                            document: Buffer.from(csv, 'utf-8'), mimetype: 'text/csv', fileName: nombreArchivo,
                            caption: `📊 *Agenda del Dr. ${agenda.medico}*\nFecha: ${new Date().toLocaleDateString('es-AR')}\nTotal: ${agenda.turnos.length} pacientes`
                        });
                        await mostrarMenuMedico(from, sesion.nombre_medico);
                    } catch (error) { await responder(from, '❌ Error al generar el archivo.'); await mostrarMenuMedico(from, sesion.nombre_medico); }
                    return;
                }
                if (texto === '4') {
                    sesiones.set(from, { ...sesion, paso: 'medico_cambiar_pass_actual' });
                    await responder(from, '🔐 *CAMBIAR CONTRASEÑA*\n\nPor seguridad, primero escribí tu *contraseña actual*:\n\nEscribí *9* para cancelar.');
                    return;
                }
                await responder(from, '❌ Opción inválida.');
                await mostrarMenuMedico(from, sesion.nombre_medico);
                return;
            }
            if (sesion && sesion.paso === 'medico_cambiar_pass_actual') {
                if (texto === '9' || texto === 'salir') { sesiones.set(from, { paso: 'medico_menu', medico_id: sesion.medico_id, password_actual: sesion.password_actual, nombre_medico: sesion.nombre_medico, especialidad_medico: sesion.especialidad_medico }); await mostrarMenuMedico(from, sesion.nombre_medico); return; }
                const passActual = textoOriginal.trim();
                if (passActual !== sesion.password_actual) { await responder(from, '❌ Contraseña actual incorrecta. Intentá de nuevo o escribí *9* para cancelar.'); return; }
                sesiones.set(from, { ...sesion, paso: 'medico_cambiar_pass_nueva' });
                await responder(from, '✅ Contraseña correcta.\n\nAhora escribí tu *nueva contraseña*:\n*Recomendación:* Usá al menos 6 caracteres.\n\nEscribí *9* para cancelar.');
                return;
            }
            if (sesion && sesion.paso === 'medico_cambiar_pass_nueva') {
                if (texto === '9' || texto === 'salir') { sesiones.set(from, { paso: 'medico_menu', medico_id: sesion.medico_id, password_actual: sesion.password_actual, nombre_medico: sesion.nombre_medico, especialidad_medico: sesion.especialidad_medico }); await mostrarMenuMedico(from, sesion.nombre_medico); return; }
                const passNueva = textoOriginal.trim();
                if (passNueva.length < 4) { await responder(from, '❌ La contraseña debe tener al menos 4 caracteres.'); return; }
                try {
                    const res = await axios.post(`${BACKEND}/medicos/${sesion.medico_id}/cambiar-password`, null, { params: { password_actual: sesion.password_actual, password_nueva: passNueva } });
                    if (res.data.ok) {
                        sesiones.set(from, { paso: 'medico_menu', medico_id: sesion.medico_id, password_actual: passNueva, nombre_medico: sesion.nombre_medico, especialidad_medico: sesion.especialidad_medico });
                        await responder(from, `✅ Contraseña cambiada exitosamente.\n\n🔑 Tu nueva contraseña es: *${passNueva}*`);
                        await mostrarMenuMedico(from, sesion.nombre_medico);
                    } else { await responder(from, `❌ ${res.data.mensaje}`); await mostrarMenuMedico(from, sesion.nombre_medico); }
                } catch (error) {
                    sesiones.set(from, { paso: 'medico_menu', medico_id: sesion.medico_id, password_actual: sesion.password_actual, nombre_medico: sesion.nombre_medico, especialidad_medico: sesion.especialidad_medico });
                    await responder(from, '❌ Error al cambiar la contraseña.'); await mostrarMenuMedico(from, sesion.nombre_medico);
                }
                return;
            }

            // ============================================================
            // MODO ADMINISTRADOR SECRETO
            // ============================================================
            if (texto === 'admin' || texto === 'administrador') {
                if (sesion && sesion.rol === 'admin') { await responder(from, 'Ya estás en modo administrador. Usá los comandos del menú.'); return; }
                sesiones.set(from, { paso: 'admin_auth', rol: 'pendiente' });
                await responder(from, '🔐 *MODO ADMINISTRADOR*\n\nIngresá la *clave de acceso* para continuar:\n*(Escribí 9 para cancelar)*');
                return;
            }
            if (sesion && sesion.paso === 'admin_auth') {
                if (texto === '9' || texto === 'salir') { sesiones.delete(from); await responder(from, 'Acceso cancelado.'); return; }
                if (texto === process.env.ADMIN_PASSWORD) {
                    sesiones.set(from, { paso: 'admin_menu', rol: 'admin' });
                    await mostrarMenuAdmin(from);
                    return;
                } else {
                    await responder(from, '❌ Clave incorrecta. Acceso denegado.');
                    sesiones.delete(from);
                    return;
                }
            }

            // ============================================================
            // ACCIONES DEL ADMINISTRADOR
            // ============================================================
            if (sesion && sesion.rol === 'admin') {
                if (texto === '9' || texto === 'salir') {
                    if (!sesion.paso || sesion.paso === 'admin_menu' || sesion.paso === null) {
                        sesiones.delete(from);
                        await responder(from, 'Sesión de administrador cerrada. ¡Hasta luego!');
                    } else {
                        sesiones.set(from, { ...sesion, paso: null });
                        await responder(from, 'Operación cancelada.');
                        await mostrarMenuAdmin(from);
                    }
                    return;
                }

                // --- PASOS INTERMEDIOS ---
                if (sesion.paso === 'admin_add_medico') {
                    const partes = textoOriginal.split(',');
                    if (partes.length < 2) { await responder(from, '❌ Formato incorrecto. Usá: Nombre, Especialidad'); return; }
                    try {
                        await axios.post(`${BACKEND}/medicos/`, null, { params: { nombre: partes[0].trim(), especialidad: partes[1].trim() } });
                        sesiones.set(from, { ...sesion, paso: null });
                        await responder(from, `✅ Médico *${partes[0].trim()}* agregado correctamente.`);
                        await mostrarMenuAdmin(from);
                    } catch (error) { await responder(from, '❌ Error al agregar el médico.'); await mostrarMenuAdmin(from); }
                    return;
                }

                if (sesion.paso === 'admin_add_horario_id') {
                    const idMedico = parseInt(texto);
                    const medico = sesion.medicos_lista.find(m => m.id === idMedico);
                    if (!medico) { await responder(from, '❌ ID inválido. Escribí el número correcto o *9* para cancelar.'); return; }
                    sesiones.set(from, { ...sesion, paso: 'admin_add_horario_datos', medico_seleccionado: medico });
                    await responder(from, `Elegiste a: *${medico.nombre}*\n\nAhora escribí el *día y la hora* separados por coma.\n*Ejemplo:* lunes, 08:00\n\nEscribí *9* para cancelar.`);
                    return;
                }

                if (sesion.paso === 'admin_add_horario_datos') {
                    const partes = texto.split(',');
                    if (partes.length < 2) { await responder(from, '❌ Formato incorrecto. Usá: dia, hora (ej: lunes, 08:00)'); return; }
                    try {
                        await axios.post(`${BACKEND}/medicos/${sesion.medico_seleccionado.id}/horarios`, { dia_semana: partes[0].trim().toLowerCase(), hora: partes[1].trim() + ":00" });
                        sesiones.set(from, { ...sesion, paso: null });
                        await responder(from, `✅ Horario agregado correctamente para *${sesion.medico_seleccionado.nombre}*.`);
                        await mostrarMenuAdmin(from);
                    } catch (error) { sesiones.set(from, { ...sesion, paso: null }); await responder(from, '❌ Error al agregar el horario.'); await mostrarMenuAdmin(from); }
                    return;
                }

                // --- OPCIÓN 5: ELIMINAR MÉDICO CON TRANSFERENCIA INTELIGENTE ---
                if (sesion.paso === 'admin_eliminar_medico_id') {
                    const idMedico = parseInt(texto);
                    const medico = sesion.medicos_lista.find(m => m.id === idMedico);
                    if (!medico) { await responder(from, '❌ ID inválido. Escribí el número correcto o *9* para cancelar.'); return; }
                    try {
                        const turnosRes = await axios.get(`${BACKEND}/medicos/${idMedico}/turnos`);
                        const turnosFuturos = turnosRes.data.turnos.length;
                        if (turnosFuturos > 0) {
                            sesiones.set(from, { ...sesion, paso: 'admin_eliminar_medico_elegir_especialidad', medico_eliminar: medico, turnos_futuros: turnosFuturos });
                            await responder(from, `⚠️ *ATENCIÓN - MÉDICO CON TURNOS*\n\n👨‍⚕️ Dr. ${medico.nombre}\n🏥 Especialidad: *${medico.especialidad}*\n📅 Turnos futuros: *${turnosFuturos}*\n\n*¿A qué especialidad querés transferir los turnos?*\n\n*1.* A la misma especialidad (${medico.especialidad})\n*2.* A otra especialidad diferente\n*3.* Cancelar eliminación\n\nEscribí el número de la opción:`);
                        } else {
                            sesiones.set(from, { ...sesion, paso: 'admin_eliminar_medico_confirmar', medico_eliminar: medico });
                            await responder(from, `El Dr. ${medico.nombre} no tiene turnos futuros.\n\n¿Estás seguro de eliminarlo?\n\nEscribí *SI* para confirmar o *9* para cancelar.`);
                        }
                    } catch (error) { await responder(from, '❌ Error al verificar turnos del médico.'); await mostrarMenuAdmin(from); }
                    return;
                }

                if (sesion.paso === 'admin_eliminar_medico_elegir_especialidad') {
                    if (texto === '9' || texto === 'salir' || texto === '3') { sesiones.set(from, { ...sesion, paso: null }); await responder(from, 'Operación cancelada.'); await mostrarMenuAdmin(from); return; }
                    if (texto === '1') {
                        try {
                            const res = await axios.get(`${BACKEND}/medicos/por-especialidad/${encodeURIComponent(sesion.medico_eliminar.especialidad)}?excluir_id=${sesion.medico_eliminar.id}`);
                            const medicosDisponibles = res.data;
                            if (medicosDisponibles.length === 0) {
                                sesiones.set(from, { ...sesion, paso: 'admin_eliminar_medico_sin_alternativas', medico_eliminar: sesion.medico_eliminar, turnos_futuros: sesion.turnos_futuros });
                                await responder(from, `⚠️ *NO HAY MÉDICOS DISPONIBLES*\n\nNo hay otros médicos de la especialidad *${sesion.medico_eliminar.especialidad}*.\n\n*¿Qué querés hacer?*\n\n*1.* Transferir a otra especialidad\n*2.* Cancelar eliminación\n\nEscribí el número de la opción:`);
                                return;
                            }
                            let msg = `👨‍⚕️ *MÉDICOS DE ${sesion.medico_eliminar.especialidad.toUpperCase()}*\n\nElegí a cuál transferir los *${sesion.turnos_futuros} turno(s)*:\n\n`;
                            medicosDisponibles.forEach(m => { msg += `*${m.id}.* ${m.nombre}\n`; });
                            msg += '\nEscribí el *ID* del médico (o *9* para cancelar):';
                            sesiones.set(from, { ...sesion, paso: 'admin_eliminar_medico_elegir_destino', medicos_destino: medicosDisponibles });
                            await responder(from, msg);
                        } catch (error) { await responder(from, '❌ Error al cargar médicos de la especialidad.'); await mostrarMenuAdmin(from); }
                        return;
                    }
                    if (texto === '2') {
                        try {
                            const res = await axios.get(`${BACKEND}/medicos/especialidades`);
                            const especialidades = res.data.especialidades.filter(e => e !== sesion.medico_eliminar.especialidad);
                            if (especialidades.length === 0) { await responder(from, '❌ No hay otras especialidades disponibles.'); await mostrarMenuAdmin(from); return; }
                            let msg = `🏥 *OTRAS ESPECIALIDADES*\n\nElegí la especialidad destino:\n\n`;
                            especialidades.forEach((e, i) => { msg += `*${i + 1}.* ${e}\n`; });
                            msg += '\nEscribí el *número* de la especialidad (o *9* para cancelar):';
                            sesiones.set(from, { ...sesion, paso: 'admin_eliminar_medico_elegir_esp_destino', especialidades_disponibles: especialidades });
                            await responder(from, msg);
                        } catch (error) { await responder(from, '❌ Error al cargar especialidades.'); await mostrarMenuAdmin(from); }
                        return;
                    }
                    await responder(from, '❌ Opción inválida. Escribí 1, 2 o 3.');
                    return;
                }

                if (sesion.paso === 'admin_eliminar_medico_elegir_esp_destino') {
                    if (texto === '9' || texto === 'salir') { sesiones.set(from, { ...sesion, paso: null }); await responder(from, 'Operación cancelada.'); await mostrarMenuAdmin(from); return; }
                    const indice = parseInt(texto) - 1;
                    if (isNaN(indice) || indice < 0 || indice >= sesion.especialidades_disponibles.length) { await responder(from, '❌ Número inválido. Escribí el número correcto o *9* para cancelar.'); return; }
                    const especialidadDestino = sesion.especialidades_disponibles[indice];
                    try {
                        const res = await axios.get(`${BACKEND}/medicos/por-especialidad/${encodeURIComponent(especialidadDestino)}`);
                        const medicosDisponibles = res.data;
                        if (medicosDisponibles.length === 0) { await responder(from, `❌ No hay médicos en la especialidad ${especialidadDestino}.`); await mostrarMenuAdmin(from); return; }
                        let msg = `👨‍⚕️ *MÉDICOS DE ${especialidadDestino.toUpperCase()}*\n\nElegí a cuál transferir los *${sesion.turnos_futuros} turno(s)*:\n\n`;
                        medicosDisponibles.forEach(m => { msg += `*${m.id}.* ${m.nombre}\n`; });
                        msg += '\nEscribí el *ID* del médico (o *9* para cancelar):';
                        sesiones.set(from, { ...sesion, paso: 'admin_eliminar_medico_elegir_destino', medicos_destino: medicosDisponibles });
                        await responder(from, msg);
                    } catch (error) { await responder(from, '❌ Error al cargar médicos de la especialidad.'); await mostrarMenuAdmin(from); }
                    return;
                }

                if (sesion.paso === 'admin_eliminar_medico_sin_alternativas') {
                    if (texto === '9' || texto === 'salir' || texto === '2') { sesiones.set(from, { ...sesion, paso: null }); await responder(from, 'Operación cancelada.'); await mostrarMenuAdmin(from); return; }
                    if (texto === '1') {
                        try {
                            const res = await axios.get(`${BACKEND}/medicos/especialidades`);
                            const especialidades = res.data.especialidades.filter(e => e !== sesion.medico_eliminar.especialidad);
                            if (especialidades.length === 0) { await responder(from, '❌ No hay otras especialidades disponibles.'); sesiones.set(from, { ...sesion, paso: null }); await mostrarMenuAdmin(from); return; }
                            let msg = `🏥 *OTRAS ESPECIALIDADES*\n\nElegí la especialidad destino:\n\n`;
                            especialidades.forEach((e, i) => { msg += `*${i + 1}.* ${e}\n`; });
                            msg += '\nEscribí el *número* de la especialidad (o *9* para cancelar):';
                            sesiones.set(from, { ...sesion, paso: 'admin_eliminar_medico_elegir_esp_destino', especialidades_disponibles: especialidades });
                            await responder(from, msg);
                        } catch (error) { sesiones.set(from, { ...sesion, paso: null }); await responder(from, '❌ Error al cargar especialidades.'); await mostrarMenuAdmin(from); }
                        return;
                    }
                    await responder(from, '❌ Opción inválida. Escribí 1 o 2.');
                    return;
                }

                if (sesion.paso === 'admin_eliminar_medico_elegir_destino') {
                    if (texto === '9' || texto === 'salir') { sesiones.set(from, { ...sesion, paso: null }); await responder(from, 'Operación cancelada.'); await mostrarMenuAdmin(from); return; }
                    const idMedicoDestino = parseInt(texto);
                    const medicoDestino = sesion.medicos_destino.find(m => m.id === idMedicoDestino);
                    if (!medicoDestino) { await responder(from, '❌ ID inválido. Escribí el número correcto o *9* para cancelar.'); return; }
                    sesiones.set(from, { ...sesion, paso: 'admin_eliminar_medico_confirmar_transferencia', medico_destino: medicoDestino });
                    await responder(from, `📋 *CONFIRMAR TRANSFERENCIA*\n\n👨‍⚕️ Médico a eliminar: *${sesion.medico_eliminar.nombre}*\n🏥 Especialidad original: ${sesion.medico_eliminar.especialidad}\n📅 Turnos a transferir: *${sesion.turnos_futuros}*\n\n➡️ Transferir a: *${medicoDestino.nombre}*\n🏥 Especialidad destino: ${medicoDestino.especialidad}\n\n¿Confirmás la operación?\n\nEscribí *SI* para confirmar o *9* para cancelar.`);
                    return;
                }

                if (sesion.paso === 'admin_eliminar_medico_confirmar_transferencia') {
                    if (texto === '9' || texto === 'salir') { sesiones.set(from, { ...sesion, paso: null }); await responder(from, 'Operación cancelada.'); await mostrarMenuAdmin(from); return; }
                    if (texto.toLowerCase() === 'si' || texto.toLowerCase() === 'sí') {
                        try {
                            // Usamos la ruta de admin para transferir, ya que la tenías funcionando ahí
                            const transferRes = await axios.post(`${BACKEND}/admin/transferir-turnos`, null, { params: { medico_origen_id: sesion.medico_eliminar.id, medico_destino_id: sesion.medico_destino.id } });
                            await axios.delete(`${BACKEND}/medicos/${sesion.medico_eliminar.id}`);
                            sesiones.set(from, { ...sesion, paso: null });
                            await responder(from, `✅ *OPERACIÓN COMPLETADA*\n\n🔄 Se transfirieron *${transferRes.data.cantidad} turno(s)*\n👨‍⚕️ Del Dr. ${sesion.medico_eliminar.nombre}\n➡️ Al Dr. ${sesion.medico_destino.nombre} (${sesion.medico_destino.especialidad})\n\n🗑️ El Dr. ${sesion.medico_eliminar.nombre} fue eliminado del sistema.`);
                            await mostrarMenuAdmin(from);
                        } catch (error) {
                            console.error('Error en transferencia:', error.response?.data || error.message);
                            sesiones.set(from, { ...sesion, paso: null });
                            await responder(from, '❌ Error al transferir turnos o eliminar médico.');
                            await mostrarMenuAdmin(from);
                        }
                        return;
                    }
                    await responder(from, 'Escribí *SI* para confirmar o *9* para cancelar.');
                    return;
                }

                if (sesion.paso === 'admin_eliminar_medico_confirmar') {
                    if (texto === '9' || texto === 'salir') { sesiones.set(from, { ...sesion, paso: null }); await responder(from, 'Operación cancelada.'); await mostrarMenuAdmin(from); return; }
                    if (texto.toLowerCase() === 'si' || texto.toLowerCase() === 'sí') {
                        try {
                            await axios.delete(`${BACKEND}/medicos/${sesion.medico_eliminar.id}`);
                            sesiones.set(from, { ...sesion, paso: null });
                            await responder(from, `✅ Médico ${sesion.medico_eliminar.nombre} eliminado correctamente.`);
                            await mostrarMenuAdmin(from);
                        } catch (error) { sesiones.set(from, { ...sesion, paso: null }); await responder(from, '❌ Error al eliminar el médico.'); await mostrarMenuAdmin(from); }
                        return;
                    }
                    await responder(from, 'Escribí *SI* para confirmar o *9* para cancelar.');
                    return;
                }

                // --- OPCIÓN 6: Modificar horario ---
                if (sesion.paso === 'admin_modificar_horario_medico') {
                    const idMedico = parseInt(texto);
                    const medico = sesion.medicos_lista.find(m => m.id === idMedico);
                    if (!medico) { await responder(from, '❌ ID inválido. Escribí el número correcto o *9* para cancelar.'); return; }
                    try {
                        const res = await axios.get(`${BACKEND}/medicos/${idMedico}/horarios`);
                        const horarios = res.data.horarios;
                        if (horarios.length === 0) { sesiones.set(from, { ...sesion, paso: null }); await responder(from, `El Dr. ${medico.nombre} no tiene horarios cargados.`); await mostrarMenuAdmin(from); return; }
                        let msg = `📋 *Horarios del Dr. ${medico.nombre}:*\n\n`;
                        horarios.forEach(h => { msg += `*ID ${h.id}:* ${h.dia_semana} a las ${h.hora}\n`; });
                        msg += '\nEscribí el *ID del horario* que querés modificar (o *9* para cancelar).';
                        sesiones.set(from, { ...sesion, paso: 'admin_modificar_horario_elegir', medico_seleccionado: medico, horarios_lista: horarios });
                        await responder(from, msg);
                    } catch (error) { sesiones.set(from, { ...sesion, paso: null }); await responder(from, '❌ Error al cargar los horarios.'); await mostrarMenuAdmin(from); }
                    return;
                }
                if (sesion.paso === 'admin_modificar_horario_elegir') {
                    const idHorario = parseInt(texto);
                    const horario = sesion.horarios_lista.find(h => h.id === idHorario);
                    if (!horario) { await responder(from, '❌ ID inválido. Escribí el número correcto o *9* para cancelar.'); return; }
                    sesiones.set(from, { ...sesion, paso: 'admin_modificar_horario_nuevo', horario_seleccionado: horario, medico_seleccionado: sesion.medico_seleccionado });
                    await responder(from, `Elegiste: *${horario.dia_semana} a las ${horario.hora}*\n\nAhora escribí el *nuevo día y hora* separados por coma.\n*Ejemplo:* martes, 10:00\n\nEscribí *9* para cancelar.`);
                    return;
                }
                if (sesion.paso === 'admin_modificar_horario_nuevo') {
                    const partes = texto.split(',');
                    if (partes.length < 2) { await responder(from, '❌ Formato incorrecto. Usá: dia, hora (ej: martes, 10:00)'); return; }
                    try {
                        await axios.put(`${BACKEND}/medicos/horarios/${sesion.horario_seleccionado.id}`, { dia_semana: partes[0].trim().toLowerCase(), hora: partes[1].trim() + ":00" });
                        sesiones.set(from, { ...sesion, paso: null });
                        await responder(from, `✅ Horario modificado correctamente.`);
                        await mostrarMenuAdmin(from);
                    } catch (error) { sesiones.set(from, { ...sesion, paso: null }); await responder(from, '❌ Error al modificar el horario.'); await mostrarMenuAdmin(from); }
                    return;
                }

                // --- OPCIÓN 7: Modificar datos del médico ---
                if (sesion.paso === 'admin_edit_medico_paso1') {
                    const idMedico = parseInt(texto);
                    const medico = sesion.medicos_lista.find(m => m.id === idMedico);
                    if (!medico) { await responder(from, '❌ ID inválido. Escribí el número correcto o *9* para cancelar.'); return; }
                    sesiones.set(from, { ...sesion, paso: 'admin_edit_medico_paso2', medico_edit: medico });
                    await responder(from, `Elegiste al: *${medico.nombre} (${medico.especialidad})*\n\nAhora escribí el *nuevo nombre y especialidad* separados por coma.\n*Ejemplo:* Dr. Juan Carlos Pérez, Cardiología\n\nEscribí *9* para cancelar.`);
                    return;
                }
                if (sesion.paso === 'admin_edit_medico_paso2') {
                    const partes = textoOriginal.split(',');
                    if (partes.length < 2) { await responder(from, '❌ Formato incorrecto. Usá: Nombre, Especialidad'); return; }
                    try {
                        await axios.put(`${BACKEND}/medicos/${sesion.medico_edit.id}`, { nombre: partes[0].trim(), especialidad: partes[1].trim() });
                        sesiones.set(from, { ...sesion, paso: null });
                        await responder(from, `✅ Datos del médico actualizados correctamente.\n\n*${partes[0].trim()}* - *${partes[1].trim()}*`);
                        await mostrarMenuAdmin(from);
                    } catch (error) { sesiones.set(from, { ...sesion, paso: null }); await responder(from, '❌ Error al modificar los datos del médico.'); await mostrarMenuAdmin(from); }
                    return;
                }

                // --- OPCIÓN 8: Eliminar horario específico ---
                if (sesion.paso === 'admin_eliminar_horario_medico') {
                    const idMedico = parseInt(texto);
                    const medico = sesion.medicos_lista.find(m => m.id === idMedico);
                    if (!medico) { await responder(from, '❌ ID inválido. Escribí el número correcto o *9* para cancelar.'); return; }
                    try {
                        const res = await axios.get(`${BACKEND}/medicos/${idMedico}/horarios`);
                        const horarios = res.data.horarios;
                        if (horarios.length === 0) { sesiones.set(from, { ...sesion, paso: null }); await responder(from, `El Dr. ${medico.nombre} no tiene horarios cargados.`); await mostrarMenuAdmin(from); return; }
                        let msg = `🗑️ *ELIMINAR HORARIO*\n\nHorarios del Dr. ${medico.nombre}:\n\n`;
                        horarios.forEach(h => { msg += `*ID ${h.id}:* ${h.dia_semana} a las ${h.hora}\n`; });
                        msg += '\nEscribí el *ID del horario* que querés ELIMINAR (o *9* para cancelar).';
                        sesiones.set(from, { ...sesion, paso: 'admin_eliminar_horario_elegir', medico_seleccionado: medico, horarios_lista: horarios });
                        await responder(from, msg);
                    } catch (error) { sesiones.set(from, { ...sesion, paso: null }); await responder(from, '❌ Error al cargar los horarios.'); await mostrarMenuAdmin(from); }
                    return;
                }
                if (sesion.paso === 'admin_eliminar_horario_elegir') {
                    const idHorario = parseInt(texto);
                    const horario = sesion.horarios_lista.find(h => h.id === idHorario);
                    if (!horario) { await responder(from, '❌ ID inválido. Escribí el número correcto o *9* para cancelar.'); return; }
                    try {
                        await axios.delete(`${BACKEND}/medicos/horarios/${idHorario}`);
                        sesiones.set(from, { ...sesion, paso: null });
                        await responder(from, `✅ Horario eliminado correctamente.`);
                        await mostrarMenuAdmin(from);
                    } catch (error) { sesiones.set(from, { ...sesion, paso: null }); await responder(from, '❌ Error al eliminar el horario.'); await mostrarMenuAdmin(from); }
                    return;
                }

                // --- OPCIÓN 10: Gestionar contraseñas ---
                if (sesion.paso === 'admin_pass_menu') {
                    if (texto === '9' || texto === 'salir') { sesiones.set(from, { ...sesion, paso: null }); await responder(from, 'Operación cancelada.'); await mostrarMenuAdmin(from); return; }
                    if (texto === '1') {
                        let msg = 'Elegí el médico al que querés asignar/cambiar contraseña:\n\n';
                        sesion.medicos_lista.forEach(m => { msg += `*${m.id}.* ${m.nombre}\n`; });
                        msg += '\nEscribí el *ID* del médico (o *9* para cancelar):';
                        sesiones.set(from, { ...sesion, paso: 'admin_pass_elegir_medico' });
                        await responder(from, msg);
                        return;
                    }
                    await responder(from, '❌ Opción inválida. Escribí 1 o 9.');
                    return;
                }
                if (sesion.paso === 'admin_pass_elegir_medico') {
                    if (texto === '9' || texto === 'salir') { sesiones.set(from, { ...sesion, paso: null }); await responder(from, 'Operación cancelada.'); await mostrarMenuAdmin(from); return; }
                    const idMedico = parseInt(texto);
                    const medico = sesion.medicos_lista.find(m => m.id === idMedico);
                    if (!medico) { await responder(from, '❌ ID inválido. Escribí el número correcto o *9* para cancelar.'); return; }
                    sesiones.set(from, { ...sesion, paso: 'admin_pass_nueva', medico_pass: medico });
                    await responder(from, `Elegiste al: *${medico.nombre}*\n\nEscribí la *nueva contraseña* para este médico.\n*Recomendación:* Usá al menos 6 caracteres.\n\nEscribí *9* para cancelar.`);
                    return;
                }
                if (sesion.paso === 'admin_pass_nueva') {
                    if (texto === '9' || texto === 'salir') { sesiones.set(from, { ...sesion, paso: null }); await responder(from, 'Operación cancelada.'); await mostrarMenuAdmin(from); return; }
                    const nuevaPassword = textoOriginal.trim();
                    if (nuevaPassword.length < 4) { await responder(from, '❌ La contraseña debe tener al menos 4 caracteres.'); return; }
                    try {
                        await axios.post(`${BACKEND}/medicos/${sesion.medico_pass.id}/asignar-password`, null, { params: { password: nuevaPassword } });
                        sesiones.set(from, { ...sesion, paso: null });
                        await responder(from, `✅ Contraseña asignada correctamente.\n\n👨‍⚕️ Médico: *${sesion.medico_pass.nombre}*\n🔑 Contraseña: *${nuevaPassword}*\n\n⚠️ *Avisale al médico esta contraseña* para que pueda acceder a su agenda escribiendo *medico*.`);
                        await mostrarMenuAdmin(from);
                    } catch (error) { sesiones.set(from, { ...sesion, paso: null }); await responder(from, '❌ Error al asignar la contraseña.'); await mostrarMenuAdmin(from); }
                    return;
                }

                // --- MENÚ PRINCIPAL DE ADMIN ---
                if (!sesion.paso || sesion.paso === 'admin_menu' || sesion.paso === null) {
                    if (texto === '1') {
                        await responder(from, '⏳ Consultando turnos...');
                        try {
                            const res = await axios.get(`${BACKEND}/admin/turnos-detallados`);
                            const turnos = res.data;
                            if (turnos.length === 0) { await responder(from, 'No hay turnos registrados en el sistema.'); } 
                            else {
                                const ultimos = turnos.slice(0, 10);
                                let msg = `📅 *ÚLTIMOS 10 TURNOS REGISTRADOS:*\n\n`;
                                ultimos.forEach(t => { msg += `🔹 *${t.fecha}* | ${t.paciente} (DNI: ${t.dni})\n   👨‍⚕️ ${t.medico} - ${t.especialidad}\n\n`; });
                                msg += `(Total en sistema: ${turnos.length} turnos. Usá la opción 4 para el listado completo).`;
                                await responder(from, msg);
                            }
                        } catch (error) { await responder(from, '❌ Error al consultar los turnos.'); }
                        return;
                    }
                    if (texto === '2') {
                        sesiones.set(from, { ...sesion, paso: 'admin_add_medico' });
                        await responder(from, '👨‍⚕️ *AGREGAR MÉDICO*\n\nEscribí el nombre y la especialidad separados por una coma.\n*Ejemplo:* Dr. Juan Perez, Cardiologia\n\nEscribí *9* para cancelar.');
                        return;
                    }
                    if (texto === '3') {
                        try {
                            const res = await axios.get(`${BACKEND}/medicos/`);
                            const medicos = res.data;
                            let msg = '🕐 *AGREGAR HORARIO*\n\nPrimero, elegí el ID del médico:\n\n';
                            medicos.forEach(m => { msg += `*${m.id}.* ${m.nombre} (${m.especialidad})\n`; });
                            msg += '\nEscribí el *número de ID* del médico (o *9* para cancelar).';
                            sesiones.set(from, { ...sesion, paso: 'admin_add_horario_id', medicos_lista: medicos });
                            await responder(from, msg);
                        } catch (error) { await responder(from, '❌ Error al cargar la lista de médicos.'); }
                        return;
                    }
                    if (texto === '4') {
                        await responder(from, '⏳ Generando archivo Excel...');
                        try {
                            const res = await axios.get(`${BACKEND}/admin/turnos-detallados`);
                            const turnos = res.data;
                            let csv = "ID,Paciente,DNI,Medico,Especialidad,Fecha\n";
                            turnos.forEach(t => { csv += `${t.id},"${t.paciente}",${t.dni},"${t.medico}","${t.especialidad}","${t.fecha}"\n`; });
                            await sock.sendMessage(from, {
                                document: Buffer.from(csv, 'utf-8'), mimetype: 'text/csv', fileName: `Turnos_Hospital_${new Date().toISOString().split('T')[0]}.csv`,
                                caption: `📊 *Listado completo de turnos*\n\nTotal de registros: ${turnos.length}\n\nPodés abrir este archivo directamente con Excel.`
                            });
                        } catch (error) { console.error('Error al exportar:', error); await responder(from, '❌ Error al generar el archivo.'); }
                        return;
                    }
                    if (texto === '5') {
                        try {
                            const res = await axios.get(`${BACKEND}/medicos/`);
                            const medicos = res.data;
                            if (medicos.length === 0) { await responder(from, 'No hay médicos registrados.'); await mostrarMenuAdmin(from); return; }
                            let msg = '❌ *ELIMINAR MÉDICO*\n\nElegí el ID del médico a eliminar:\n\n';
                            medicos.forEach(m => { msg += `*${m.id}.* ${m.nombre} (${m.especialidad})\n`; });
                            msg += '\nEscribí el *número de ID* del médico (o *9* para cancelar).';
                            sesiones.set(from, { ...sesion, paso: 'admin_eliminar_medico_id', medicos_lista: medicos });
                            await responder(from, msg);
                        } catch (error) { await responder(from, '❌ Error al cargar la lista de médicos.'); await mostrarMenuAdmin(from); }
                        return;
                    }
                    if (texto === '6') {
                        try {
                            const res = await axios.get(`${BACKEND}/medicos/`);
                            const medicos = res.data;
                            if (medicos.length === 0) { await responder(from, 'No hay médicos registrados.'); await mostrarMenuAdmin(from); return; }
                            let msg = '✏️ *MODIFICAR HORARIO*\n\nPrimero, elegí el médico:\n\n';
                            medicos.forEach(m => { msg += `*${m.id}.* ${m.nombre} (${m.especialidad})\n`; });
                            msg += '\nEscribí el *número de ID* del médico (o *9* para cancelar).';
                            sesiones.set(from, { ...sesion, paso: 'admin_modificar_horario_medico', medicos_lista: medicos });
                            await responder(from, msg);
                        } catch (error) { await responder(from, '❌ Error al cargar la lista de médicos.'); await mostrarMenuAdmin(from); }
                        return;
                    }
                    if (texto === '7') {
                        try {
                            const res = await axios.get(`${BACKEND}/medicos/`);
                            const medicos = res.data;
                            if (medicos.length === 0) { await responder(from, 'No hay médicos registrados.'); await mostrarMenuAdmin(from); return; }
                            let msg = '📝 *MODIFICAR DATOS DEL MÉDICO*\n\nElegí el médico a modificar:\n\n';
                            medicos.forEach(m => { msg += `*${m.id}.* ${m.nombre} (${m.especialidad})\n`; });
                            msg += '\nEscribí el *número de ID* del médico (o *9* para cancelar).';
                            sesiones.set(from, { ...sesion, paso: 'admin_edit_medico_paso1', medicos_lista: medicos });
                            await responder(from, msg);
                        } catch (error) { await responder(from, '❌ Error al cargar la lista de médicos.'); await mostrarMenuAdmin(from); }
                        return;
                    }
                    if (texto === '8') {
                        try {
                            const res = await axios.get(`${BACKEND}/medicos/`);
                            const medicos = res.data;
                            if (medicos.length === 0) { await responder(from, 'No hay médicos registrados.'); await mostrarMenuAdmin(from); return; }
                            let msg = '🗑️ *ELIMINAR HORARIO*\n\nPrimero, elegí el médico:\n\n';
                            medicos.forEach(m => { msg += `*${m.id}.* ${m.nombre} (${m.especialidad})\n`; });
                            msg += '\nEscribí el *número de ID* del médico (o *9* para cancelar).';
                            sesiones.set(from, { ...sesion, paso: 'admin_eliminar_horario_medico', medicos_lista: medicos });
                            await responder(from, msg);
                        } catch (error) { await responder(from, '❌ Error al cargar la lista de médicos.'); await mostrarMenuAdmin(from); }
                        return;
                    }
                    if (texto === '10') {
                        try {
                            const res = await axios.get(`${BACKEND}/medicos/credenciales`);
                            const credenciales = res.data.credenciales || {};
                            const resMedicos = await axios.get(`${BACKEND}/medicos/`);
                            const medicos = resMedicos.data;
                            let msg = '🔑 *GESTIONAR CONTRASEÑAS DE MÉDICOS*\n\n*Estado actual:*\n\n';
                            medicos.forEach(m => {
                                const tienePass = credenciales[String(m.id)] ? '✅' : '❌';
                                msg += `${tienePass} *ID ${m.id}* - ${m.nombre}\n`;
                            });
                            msg += '\n*¿Qué querés hacer?*\n*1.* Asignar/cambiar contraseña a un médico\n*9.* Cancelar\n\nEscribí el número de la opción:';
                            sesiones.set(from, { ...sesion, paso: 'admin_pass_menu', medicos_lista: medicos });
                            await responder(from, msg);
                        } catch (error) { await responder(from, '❌ Error al cargar las credenciales.'); await mostrarMenuAdmin(from); }
                        return;
                    }
                    await mostrarMenuAdmin(from);
                    return;
                }
            }

            // ============================================================
            // FLUJO NORMAL DEL PACIENTE (Sin cambios, funciona perfecto)
            // ============================================================
            if (sesion && sesion.paso === 'sacar_dni') {
                if (!/^\d{7,9}$/.test(texto)) { await responder(from, 'El DNI debe tener entre 7 y 9 números. Escribí tu DNI nuevamente o *9* para salir.'); return; }
                try {
                    const res = await axios.get(`${BACKEND}/turnos/por-dni/${texto}`);
                    if (res.data.encontrado === false) {
                        sesiones.set(from, { paso: 'sacar_registro_nombre', dni: texto });
                        await responder(from, `No encontramos un paciente con DNI *${texto}*.\n\nPara registrarte, escribí tu *Nombre y Apellido* (ej: Juan Pérez).\nO escribí *no* para cancelar.`);
                    } else {
                        sesiones.set(from, { paso: 'sacar_especialidad', dni: texto, paciente_id: res.data.paciente_id || null });
                        await pedirEspecialidadParaTurno(from, texto);
                    }
                } catch (error) { await responder(from, 'Error al consultar el sistema. Escribí *9* para salir.'); }
                return;
            }

            if (sesion && sesion.paso === 'sacar_registro_nombre') {
                if (texto === 'no' || texto === 'cancelar') { sesiones.delete(from); await responder(from, 'Registro cancelado. Escribí *menu* para ver las opciones.'); return; }
                const dni = sesion.dni;
                const nombre = textoOriginal.trim();
                try {
                    const res = await axios.post(`${BACKEND}/pacientes/`, { nombre: nombre, dni: dni });
                    const pacienteId = res.data.paciente.id;
                    const numeroReal = from.replace(/\D/g, '');
                    sesiones.set(from, { paso: 'sacar_especialidad', dni: dni, paciente_id: pacienteId, telefono_real: numeroReal });
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
                    if (!pId) { const resPac = await axios.get(`${BACKEND}/turnos/por-dni/${dni}`); pId = resPac.data.paciente_id; }
                    const res = await axios.get(`${BACKEND}/turnos/disponibles/${encodeURIComponent(especialidad)}`);
                    if (res.data.encontrado === false) { await responder(from, res.data.mensaje + '\n\nEscribí *menu* para ver las opciones.'); sesiones.delete(from); return; }
                    sesiones.set(from, { paso: 'sacar_elegir_horario', dni: dni, paciente_id: pId, horarios: res.data.horarios, especialidad: especialidad });
                    await responder(from, res.data.mensaje);
                } catch (error) { console.error('Error:', error.message); await responder(from, 'Error al buscar turnos. Escribí *9* para salir.'); sesiones.delete(from); }
                return;
            }

            if (sesion && sesion.paso === 'sacar_elegir_horario') {
                const numero = parseInt(texto);
                const horarios = sesion.horarios;
                if (isNaN(numero) || numero < 1 || numero > horarios.length) { await responder(from, `Escribí un número entre 1 y ${horarios.length}, o *9* para salir.`); return; }
                const horarioElegido = horarios[numero - 1];
                try {
                    const res = await axios.post(`${BACKEND}/turnos/reservar`, null, { params: { paciente_id: sesion.paciente_id, medico_id: horarioElegido.medico_id, fecha: horarioElegido.fecha_hora } });
                    sesiones.delete(from);
                    if (res.data.ok) { await responder(from, res.data.mensaje); await responder(from, 'Escribí *menu* para ver las opciones o *9* para salir.'); } 
                    else { await responder(from, res.data.mensaje); }
                } catch (error) { await responder(from, 'Error al reservar el turno. Escribí *9* para salir.'); sesiones.delete(from); }
                return;
            }

            if (sesion && sesion.paso === 'ver_dni') {
                if (!/^\d{7,9}$/.test(texto)) { await responder(from, 'El DNI debe tener entre 7 y 9 números. Escribí *9* para salir.'); return; }
                try {
                    const res = await axios.get(`${BACKEND}/turnos/por-dni/${texto}`);
                    await responder(from, res.data.mensaje);
                    await responder(from, 'Escribí *menu* para ver las opciones o *9* para salir.');
                } catch (error) { await responder(from, 'Error al consultar. Escribí *9* para salir.'); }
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
                } catch (error) { await responder(from, 'Error al consultar el sistema. Escribí *9* para salir.'); }
                return;
            }

            if (texto === '1') { sesiones.set(from, { paso: 'sacar_dni' }); await responder(from, '🆔 Escribí tu número de *DNI* (solo números):'); return; }
            if (texto === '2') { sesiones.set(from, { paso: 'ver_dni' }); await responder(from, '🆔 Escribí tu número de *DNI* (solo números):'); return; }
            if (texto === '3') { await responder(from, 'Para *cancelar un turno*, acercate al hospital o llamá a Mesa de Entradas.\n\n📞 Teléfono: (381) 400-0000\n🕐 Horario: lunes a viernes de 7:00 a 13:00 hs.\n\nEscribí *menu* para ver las opciones o *9* para salir.'); return; }
            
            // ============ EMERGENCIA: Opción 4 ============
            if (texto === '4') {
                let numeroPaciente = (sesion && sesion.telefono_real) ? sesion.telefono_real : from.replace(/\D/g, '');
                if (numeroPaciente.length > 15 || (!numeroPaciente.startsWith('54') && !numeroPaciente.startsWith('381'))) {
                    sesiones.set(from, { ...sesion, paso: 'emergencia_pedir_telefono' });
                    await responder(from, `🚨 *SOLICITUD DE EMERGENCIA*\n\nPara que el personal del hospital pueda contactarte, por favor respondé a este mensaje con tu *número de teléfono* (solo números, ej: 3816542126).`);
                    return;
                }
                await enviarAlertaEmergencia(from, sesion, numeroPaciente, msg);
                return;
            }

            if (sesion && sesion.paso === 'emergencia_pedir_telefono') {
                const numeroIngresado = texto.replace(/\D/g, '');
                if (numeroIngresado.length < 8) { await responder(from, 'El número parece incompleto. Por favor escribí tu número de teléfono correctamente (ej: 3816542126).'); return; }
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
                } catch (e) { await responder(from, 'No se pudieron cargar las especialidades. Escribí *9* para salir.'); }
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
        const mensajeAlerta = `🚨 *SOLICITUD DE ATENCIÓN URGENTE*\n\nUn paciente solicitó contacto urgente desde el bot.\n\n👤 *Paciente:* ${nombrePaciente}\n📞 *Teléfono:* ${numeroPaciente}\n🕐 *Fecha:* ${fechaHora}\n\n⚠️ Por favor, comunicarse con el paciente a la brevedad.`;

        const resultado = await sock.onWhatsApp(`${numeroEmergencia}@s.whatsapp.net`);
        if (!resultado || !resultado[0] || !resultado[0].exists) {
            console.error(`❌ El número de emergencia ${numeroEmergencia} NO tiene WhatsApp.`);
            await responder(from, '❌ No se pudo contactar al hospital. Llame al 107.');
            return;
        }

        await sock.sendMessage(resultado[0].jid, { text: mensajeAlerta });
        console.log(`✅ Alerta enviada con éxito al hospital.`);
        await responder(from, `✅ *Aviso enviado al hospital*\n\nEl personal se comunicará con usted al número *${numeroPaciente}* a la brevedad.\n\n⚠️ Si es una emergencia médica, llame al *107* o acuda a guardia.`);
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
    if (!telefono || !mensaje || !isBotReady) { return res.status(400).json({ error: 'Datos inválidos' }); }
    try {
        const digits = String(telefono).replace(/[\s()+.-]/g, '');
        await humanDelay();
        await sock.sendMessage(`${digits}@s.whatsapp.net`, { text: mensaje.trim() });
        return res.status(200).json({ ok: true });
    } catch (error) { return res.status(502).json({ error: 'Fallo al enviar' }); }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Servidor en puerto: ${port}`);
    connectToWhatsApp();
});