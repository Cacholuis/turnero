from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
from app.database import SessionLocal
from app.models import Turno, Paciente, Medico, HorarioAtencion
from app.whatsapp_service import enviar_notificacion_turno

router = APIRouter()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ============================================================
# CREAR TURNO (ruta original, para uso desde Mesa de Entradas)
# ============================================================
@router.post("/")
def crear_turno(paciente_id: int, medico_id: int, fecha: str, db: Session = Depends(get_db)):
    paciente = db.query(Paciente).filter(Paciente.id == paciente_id).first()
    if paciente is None:
        raise HTTPException(status_code=404, detail="Paciente no encontrado")
    telefono = paciente.telefono
    if not telefono:
        raise HTTPException(
            status_code=400,
            detail="El paciente no tiene un teléfono registrado",
        )

    nuevo = Turno(paciente_id=paciente_id, medico_id=medico_id, fecha=fecha)
    db.add(nuevo)
    db.commit()
    db.refresh(nuevo)

    mensaje = (
        "✅ Turno confirmado!\n"
        f"Paciente ID: {paciente_id}\n"
        f"Médico ID: {medico_id}\n"
        f"Fecha: {fecha}\n"
        "Hospital Público El Mollar"
    )
    notificacion_enviada = enviar_notificacion_turno(str(telefono), mensaje)

    if notificacion_enviada:
        estado = "Turno creado y confirmado por WhatsApp"
    else:
        estado = "Turno creado; no se pudo enviar la notificación por WhatsApp"

    return {"mensaje": estado, "turno": nuevo}


# ============================================================
# LISTAR TODOS LOS TURNOS (ruta original)
# ============================================================
@router.get("/")
def listar_turnos(db: Session = Depends(get_db)):
    turnos = db.query(Turno).all()
    resultado = []
    for t in turnos:
        paciente = db.query(Paciente).filter(Paciente.id == t.paciente_id).first()
        medico = db.query(Medico).filter(Medico.id == t.medico_id).first()
        resultado.append({
            "id": t.id,
            "fecha": t.fecha,
            "paciente": paciente.nombre if paciente else "Desconocido",
            "medico": medico.nombre if medico else "Desconocido",
            "especialidad": medico.especialidad if medico else "N/A"
        })
    return resultado


# ============================================================
# CONSULTAR TURNOS POR DNI
# ============================================================
@router.get("/por-dni/{dni}")
def buscar_turnos_por_dni(dni: str, especialidad: str = None, db: Session = Depends(get_db)):
    paciente = db.query(Paciente).filter(Paciente.dni == dni).first()

    if not paciente:
        return {
            "encontrado": False,
            "paciente_id": None,
            "mensaje": f"No encontramos un paciente con DNI {dni}"
        }

    turnos = db.query(Turno).filter(Turno.paciente_id == paciente.id).all()

    if not turnos:
        return {
            "encontrado": True,
            "paciente_id": paciente.id,
            "paciente": paciente.nombre,
            "mensaje": f"Hola {paciente.nombre}, no tienes turnos agendados."
        }

    turnos_por_especialidad = {}
    for turno in turnos:
        medico = db.query(Medico).filter(Medico.id == turno.medico_id).first()
        esp = medico.especialidad if medico else 'N/A'
        nombre_medico = medico.nombre if medico else 'N/A'

        if especialidad and esp.lower() != especialidad.lower():
            continue

        if esp not in turnos_por_especialidad:
            turnos_por_especialidad[esp] = {
                'medico': nombre_medico,
                'fechas': []
            }

        turnos_por_especialidad[esp]['fechas'].append(turno.fecha)

    if not turnos_por_especialidad:
        if especialidad:
            return {
                "encontrado": True,
                "paciente_id": paciente.id,
                "paciente": paciente.nombre,
                "mensaje": f"Hola {paciente.nombre}, no tienes turnos agendados para {especialidad}."
            }
        else:
            return {
                "encontrado": True,
                "paciente_id": paciente.id,
                "paciente": paciente.nombre,
                "mensaje": f"Hola {paciente.nombre}, no tienes turnos agendados."
            }

    mensaje = f"Hola {paciente.nombre}, estos son tus turnos:\n\n"

    for esp, datos in turnos_por_especialidad.items():
        mensaje += f"🏥 *{esp}*\n"
        mensaje += f"👨‍⚕️ Dr. {datos['medico']}\n"
        mensaje += "📅 Fechas disponibles:\n"

        fechas_ordenadas = sorted(datos['fechas'])
        for i, fecha in enumerate(fechas_ordenadas, 1):
            mensaje += f"   {i}. {fecha}\n"

        mensaje += "\n"

    return {
        "encontrado": True,
        "paciente_id": paciente.id,
        "paciente": paciente.nombre,
        "mensaje": mensaje
    }


# ============================================================
# VER TURNOS DISPONIBLES POR ESPECIALIDAD
# ============================================================
@router.get("/disponibles/{especialidad}")
def turnos_disponibles(especialidad: str, db: Session = Depends(get_db)):
    # Mapeo de días de la semana en español
    dias_espanol = {
        0: 'Lunes', 1: 'Martes', 2: 'Miércoles', 3: 'Jueves',
        4: 'Viernes', 5: 'Sábado', 6: 'Domingo'
    }
    
    # Buscar médicos de esa especialidad
    medicos = db.query(Medico).filter(
        Medico.especialidad.ilike(f"%{especialidad}%")
    ).all()
    
    if not medicos:
        try:
            medico_id = int(especialidad)
            medico = db.query(Medico).filter(Medico.id == medico_id).first()
            if medico:
                medicos = [medico]
        except Exception:
            pass
    
    if not medicos:
        return {
            "encontrado": False,
            "mensaje": f"No hay médicos para la especialidad '{especialidad}'."
        }
    
    medico = medicos[0]
    
    horarios_db = db.query(HorarioAtencion).filter(
        HorarioAtencion.medico_id == medico.id
    ).all()
    
    if not horarios_db:
        return {
            "encontrado": True,
            "mensaje": f"El Dr. {medico.nombre} aún no tiene horarios cargados. Contacte a Mesa de Entradas."
        }
    
    dias_map = {
        'lunes': 0, 'martes': 1, 'miércoles': 2, 'miercoles': 2,
        'jueves': 3, 'viernes': 4, 'sábado': 5, 'sabado': 5,
        'domingo': 6
    }
    
    hoy = datetime.now().date()
    horarios_disponibles = []
    
    for horario in horarios_db:
        dia_nombre = horario.dia_semana.lower()
        if dia_nombre not in dias_map:
            continue
        
        dia_numero = dias_map[dia_nombre]
        
        fechas_encontradas = 0
        for dia in range(1, 30):
            if fechas_encontradas >= 3:
                break
                
            fecha = hoy + timedelta(days=dia)
            if fecha.weekday() == dia_numero:
                # Formato interno para guardar en la Base de Datos
                fecha_hora_db = f"{fecha.strftime('%Y-%m-%d')} {horario.hora.strftime('%H:%M')}"
                
                # Formato amigable con día de la semana en español
                dia_semana_es = dias_espanol[fecha.weekday()]
                fecha_hora_display = f"{dia_semana_es} {fecha.strftime('%d/%m/%Y')} {horario.hora.strftime('%H:%M')}"
                
                turno_existente = db.query(Turno).filter(
                    Turno.fecha == fecha_hora_db,
                    Turno.medico_id == medico.id
                ).first()
                
                if not turno_existente:
                    horarios_disponibles.append({
                        "fecha_hora": fecha_hora_db,
                        "fecha_display": fecha_hora_display,
                        "medico_id": medico.id,
                        "medico_nombre": medico.nombre
                    })
                    fechas_encontradas += 1
    
    if not horarios_disponibles:
        return {
            "encontrado": True,
            "mensaje": f"No hay turnos disponibles para {medico.especialidad} en este momento."
        }
    
    horarios_a_mostrar = horarios_disponibles[:10]
    
    lineas = []
    lineas.append(f"Turnos disponibles con el Dr. {medico.nombre} ({medico.especialidad}):")
    lineas.append("")
    for i, h in enumerate(horarios_a_mostrar):
        lineas.append(f"{i+1}. 📅 *{h['fecha_display']}*")
    lineas.append("")
    lineas.append("*Respondé con el NÚMERO del turno que querés reservar.*")
    
    mensaje_final = "\n".join(lineas)
    
    return {
        "encontrado": True,
        "especialidad": medico.especialidad,
        "horarios": horarios_a_mostrar,
        "mensaje": mensaje_final
    }


# ============================================================
# RESERVAR TURNO
# ============================================================
@router.post("/reservar")
def reservar_turno(paciente_id: int, medico_id: int, fecha: str, db: Session = Depends(get_db)):
    # Verificar que el horario sigue disponible
    existente = db.query(Turno).filter(
        Turno.fecha == fecha,
        Turno.medico_id == medico_id
    ).first()

    if existente:
        return {
            "ok": False,
            "mensaje": "Ese turno ya fue reservado. Por favor elegí otro horario."
        }

    # Crear el turno
    nuevo = Turno(paciente_id=paciente_id, medico_id=medico_id, fecha=fecha)
    db.add(nuevo)
    db.commit()
    db.refresh(nuevo)

    medico = db.query(Medico).filter(Medico.id == medico_id).first()
    paciente = db.query(Paciente).filter(Paciente.id == paciente_id).first()

    # Intentar enviar notificación por WhatsApp
    try:
        telefono = paciente.telefono
        if telefono:
            lineas = []
            lineas.append("✅ *Turno confirmado*")
            lineas.append("")
            lineas.append(f"Paciente: {paciente.nombre}")
            lineas.append(f"DNI: {paciente.dni}")
            lineas.append(f"📅 Fecha: {fecha}")
            lineas.append(f"👨‍⚕️ Médico: Dr. {medico.nombre}")
            lineas.append(f"🏥 Especialidad: {medico.especialidad}")
            lineas.append("")
            lineas.append("Por favor, acercate al hospital 15 minutos antes de tu turno.")
            mensaje = "\n".join(lineas)
            enviar_notificacion_turno(str(telefono), mensaje)
    except Exception as e:
        print(f"⚠️ No se pudo enviar notificación: {e}")

    # Armar mensaje de confirmación
    lineas = []
    lineas.append("✅ *Turno confirmado*")
    lineas.append("")
    lineas.append(f"Paciente: {paciente.nombre}")
    lineas.append(f"DNI: {paciente.dni}")
    lineas.append(f"📅 Fecha: {fecha}")
    lineas.append(f"👨‍⚕️ Médico: Dr. {medico.nombre}")
    lineas.append(f"🏥 Especialidad: {medico.especialidad}")
    lineas.append("")
    lineas.append("Por favor, acercate al hospital 15 minutos antes de tu turno.")
    mensaje_confirmacion = "\n".join(lineas)

    return {
        "ok": True,
        "mensaje": mensaje_confirmacion
    }