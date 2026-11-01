from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from app.database import SessionLocal
from app.models import Medico, HorarioAtencion, Turno, Paciente
import json
import os
from datetime import datetime

router = APIRouter()

# Ruta absoluta al archivo de credenciales (sube 4 niveles desde medicos.py hasta TURNERO)
RUTA_CREDENCIALES = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))), "medicos_auth.json")

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

class MedicoCreate(BaseModel):
    nombre: str
    especialidad: str

class MedicoUpdate(BaseModel):
    nombre: str
    especialidad: str

class HorarioCreate(BaseModel):
    dia_semana: str
    hora: str

@router.post("/")
def crear_medico(nombre: str, especialidad: str, db: Session = Depends(get_db)):
    nuevo = Medico(nombre=nombre, especialidad=especialidad)
    db.add(nuevo)
    db.commit()
    db.refresh(nuevo)
    return {"mensaje": "Médico creado correctamente", "medico": nuevo}

@router.get("/")
def listar_medicos(db: Session = Depends(get_db)):
    return db.query(Medico).all()

@router.get("/especialidades")
def listar_especialidades(db: Session = Depends(get_db)):
    medicos = db.query(Medico).all()
    especialidades = set()
    for medico in medicos:
        if medico.especialidad:
            especialidades.add(medico.especialidad)
    especialidades_ordenadas = sorted(list(especialidades))
    return {
        "especialidades": especialidades_ordenadas,
        "total": len(especialidades_ordenadas)
    }

@router.put("/{medico_id}")
def modificar_medico(medico_id: int, datos: MedicoUpdate, db: Session = Depends(get_db)):
    medico = db.query(Medico).filter(Medico.id == medico_id).first()
    if not medico:
        raise HTTPException(status_code=404, detail="Médico no encontrado")
    medico.nombre = datos.nombre
    medico.especialidad = datos.especialidad
    db.commit()
    return {"ok": True, "mensaje": f"Datos del Dr. {medico.nombre} actualizados."}

@router.delete("/{medico_id}")
def eliminar_medico(medico_id: int, db: Session = Depends(get_db)):
    medico = db.query(Medico).filter(Medico.id == medico_id).first()
    if not medico:
        raise HTTPException(status_code=404, detail="Médico no encontrado")
    
    turnos_reservados = db.query(Turno).filter(Turno.medico_id == medico_id).count()
    if turnos_reservados > 0:
        return {"ok": False, "mensaje": f"No se puede eliminar. Tiene {turnos_reservados} turno(s) reservado(s)."}
    
    db.query(HorarioAtencion).filter(HorarioAtencion.medico_id == medico_id).delete()
    db.delete(medico)
    db.commit()
    return {"ok": True, "mensaje": f"Médico {medico.nombre} eliminado correctamente."}

@router.get("/por-especialidad/{especialidad}")
def get_medicos_por_especialidad(especialidad: str, excluir_id: int = None, db: Session = Depends(get_db)):
    query = db.query(Medico).filter(Medico.especialidad.ilike(f"%{especialidad}%"))
    if excluir_id:
        query = query.filter(Medico.id != excluir_id)
    return [{"id": m.id, "nombre": m.nombre, "especialidad": m.especialidad} for m in query.all()]

@router.get("/{medico_id}/horarios")
def listar_horarios(medico_id: int, db: Session = Depends(get_db)):
    medico = db.query(Medico).filter(Medico.id == medico_id).first()
    if not medico:
        raise HTTPException(status_code=404, detail="Médico no encontrado")
    horarios = db.query(HorarioAtencion).filter(HorarioAtencion.medico_id == medico_id).all()
    return {
        "medico": medico.nombre,
        "especialidad": medico.especialidad,
        "horarios": [{"id": h.id, "dia_semana": h.dia_semana, "hora": h.hora.strftime("%H:%M") if h.hora else "N/A"} for h in horarios]
    }

@router.post("/{medico_id}/horarios")
def crear_horario(medico_id: int, datos: HorarioCreate, db: Session = Depends(get_db)):
    nuevo = HorarioAtencion(medico_id=medico_id, dia_semana=datos.dia_semana, hora=datos.hora)
    db.add(nuevo)
    db.commit()
    return {"mensaje": "Horario cargado exitosamente"}

@router.put("/horarios/{horario_id}")
def modificar_horario(horario_id: int, datos: HorarioCreate, db: Session = Depends(get_db)):
    horario = db.query(HorarioAtencion).filter(HorarioAtencion.id == horario_id).first()
    if not horario:
        raise HTTPException(status_code=404, detail="Horario no encontrado")
    horario.dia_semana = datos.dia_semana
    horario.hora = datos.hora
    db.commit()
    return {"ok": True, "mensaje": "Horario modificado correctamente"}

@router.delete("/horarios/{horario_id}")
def eliminar_horario(horario_id: int, db: Session = Depends(get_db)):
    horario = db.query(HorarioAtencion).filter(HorarioAtencion.id == horario_id).first()
    if not horario:
        raise HTTPException(status_code=404, detail="Horario no encontrado")
    db.delete(horario)
    db.commit()
    return {"ok": True, "mensaje": "Horario eliminado correctamente"}

@router.get("/{medico_id}/agenda")
def get_agenda(medico_id: int, db: Session = Depends(get_db)):
    medico = db.query(Medico).filter(Medico.id == medico_id).first()
    if not medico:
        raise HTTPException(status_code=404, detail="Médico no encontrado")
    hoy = datetime.now().strftime("%Y-%m-%d")
    query = db.query(Turno.id, Paciente.nombre.label("paciente"), Paciente.dni, Turno.fecha)\
        .join(Paciente, Turno.paciente_id == Paciente.id)\
        .filter(Turno.medico_id == medico_id, Turno.fecha.like(f"{hoy}%"))\
        .order_by(Turno.fecha.asc())
    return {
        "medico": medico.nombre, "especialidad": medico.especialidad, "fecha": hoy,
        "turnos": [{"id": r.id, "paciente": r.paciente, "dni": r.dni, "hora": r.fecha.strftime("%H:%M") if r.fecha else "N/A"} for r in query.all()]
    }

@router.get("/{medico_id}/turnos")
def get_mis_turnos(medico_id: int, db: Session = Depends(get_db)):
    medico = db.query(Medico).filter(Medico.id == medico_id).first()
    if not medico:
        raise HTTPException(status_code=404, detail="Médico no encontrado")
    hoy = datetime.now().strftime("%Y-%m-%d")
    query = db.query(Turno.id, Paciente.nombre.label("paciente"), Paciente.dni, Turno.fecha)\
        .join(Paciente, Turno.paciente_id == Paciente.id)\
        .filter(Turno.medico_id == medico_id, Turno.fecha >= hoy)\
        .order_by(Turno.fecha.asc())
    return {
        "medico": medico.nombre, "especialidad": medico.especialidad,
        "turnos": [{"id": r.id, "paciente": r.paciente, "dni": r.dni, "fecha": r.fecha.strftime("%d/%m/%Y %H:%M") if r.fecha else "N/A"} for r in query.all()]
    }

@router.post("/{medico_id}/verificar-credencial")
def verificar_credencial(medico_id: int, password: str):
    try:
        with open(RUTA_CREDENCIALES, "r", encoding="utf-8") as f:
            credenciales = json.load(f)
        if str(medico_id) in credenciales and credenciales[str(medico_id)] == password:
            return {"ok": True, "mensaje": "Credencial válida"}
        return {"ok": False, "mensaje": "ID o contraseña incorrectos"}
    except Exception as e:
        return {"ok": False, "mensaje": f"Error: {str(e)}"}

@router.post("/{medico_id}/cambiar-password")
def cambiar_password(medico_id: int, password_actual: str, password_nueva: str):
    try:
        with open(RUTA_CREDENCIALES, "r", encoding="utf-8") as f:
            credenciales = json.load(f)
        if str(medico_id) not in credenciales:
            return {"ok": False, "mensaje": "Este médico no tiene contraseña asignada"}
        if credenciales[str(medico_id)] != password_actual:
            return {"ok": False, "mensaje": "La contraseña actual es incorrecta"}
        credenciales[str(medico_id)] = password_nueva
        with open(RUTA_CREDENCIALES, "w", encoding="utf-8") as f:
            json.dump(credenciales, f, indent=2, ensure_ascii=False)
        return {"ok": True, "mensaje": "Contraseña cambiada exitosamente"}
    except Exception as e:
        return {"ok": False, "mensaje": f"Error: {str(e)}"}

@router.post("/{medico_id}/asignar-password")
def asignar_password(medico_id: int, password: str):
    try:
        if not os.path.exists(RUTA_CREDENCIALES):
            credenciales = {}
        else:
            with open(RUTA_CREDENCIALES, "r", encoding="utf-8") as f:
                credenciales = json.load(f)
        credenciales[str(medico_id)] = password
        with open(RUTA_CREDENCIALES, "w", encoding="utf-8") as f:
            json.dump(credenciales, f, indent=2, ensure_ascii=False)
        return {"ok": True, "mensaje": f"Contraseña asignada al médico ID {medico_id}"}
    except Exception as e:
        return {"ok": False, "mensaje": f"Error: {str(e)}"}

@router.get("/credenciales")
def listar_credenciales():
    try:
        if not os.path.exists(RUTA_CREDENCIALES):
            return {"ok": True, "credenciales": {}}
        with open(RUTA_CREDENCIALES, "r", encoding="utf-8") as f:
            return {"ok": True, "credenciales": json.load(f)}
    except Exception as e:
        return {"ok": False, "mensaje": str(e)}