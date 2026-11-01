from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from app.database import SessionLocal
from app.models import Turno, Paciente, Medico, HorarioAtencion

router = APIRouter()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ============================================================
# MODELOS DE DATOS
# ============================================================
class MedicoCreate(BaseModel):
    nombre: str
    especialidad: str

class MedicoUpdate(BaseModel):
    nombre: str
    especialidad: str

class HorarioCreate(BaseModel):
    medico_id: int
    dia_semana: str
    hora: str

# ============================================================
# LISTAR MÉDICOS
# ============================================================
@router.get("/medicos-lista")
def get_medicos(db: Session = Depends(get_db)):
    return db.query(Medico).all()

# ============================================================
# CREAR MÉDICO
# ============================================================
@router.post("/medicos")
def crear_medico(datos: MedicoCreate, db: Session = Depends(get_db)):
    nuevo = Medico(nombre=datos.nombre, especialidad=datos.especialidad)
    db.add(nuevo)
    db.commit()
    db.refresh(nuevo)
    return {"mensaje": "Médico creado exitosamente", "id": nuevo.id}

# ============================================================
# MODIFICAR DATOS DEL MÉDICO (opción 7)
# ============================================================
@router.put("/medicos/{medico_id}")
def modificar_medico(medico_id: int, datos: MedicoUpdate, db: Session = Depends(get_db)):
    medico = db.query(Medico).filter(Medico.id == medico_id).first()
    if not medico:
        raise HTTPException(status_code=404, detail="Médico no encontrado")
    
    medico.nombre = datos.nombre
    medico.especialidad = datos.especialidad
    
    db.commit()
    db.refresh(medico)
    
    return {
        "ok": True,
        "mensaje": f"Datos del Dr. {medico.nombre} actualizados correctamente."
    }

# ============================================================
# ELIMINAR MÉDICO (opción 5)
# ============================================================
@router.delete("/medicos/{medico_id}")
def eliminar_medico(medico_id: int, db: Session = Depends(get_db)):
    medico = db.query(Medico).filter(Medico.id == medico_id).first()
    if not medico:
        raise HTTPException(status_code=404, detail="Médico no encontrado")
    
    # Verificar si tiene turnos reservados
    turnos_reservados = db.query(Turno).filter(Turno.medico_id == medico_id).count()
    if turnos_reservados > 0:
        return {
            "ok": False,
            "mensaje": f"No se puede eliminar al Dr. {medico.nombre} porque tiene {turnos_reservados} turno(s) reservado(s). Primero debe cancelar esos turnos."
        }
    
    # Eliminar horarios del médico
    db.query(HorarioAtencion).filter(HorarioAtencion.medico_id == medico_id).delete()
    
    # Eliminar el médico
    db.delete(medico)
    db.commit()
    
    return {
        "ok": True,
        "mensaje": f"Médico {medico.nombre} eliminado correctamente junto con sus horarios."
    }

# ============================================================
# CREAR HORARIO
# ============================================================
@router.post("/horarios")
def crear_horario(datos: HorarioCreate, db: Session = Depends(get_db)):
    nuevo = HorarioAtencion(medico_id=datos.medico_id, dia_semana=datos.dia_semana, hora=datos.hora)
    db.add(nuevo)
    db.commit()
    return {"mensaje": "Horario cargado exitosamente"}

# ============================================================
# LISTAR HORARIOS DE UN MÉDICO (opción 6)
# ============================================================
@router.get("/horarios/{medico_id}")
def listar_horarios_medico(medico_id: int, db: Session = Depends(get_db)):
    medico = db.query(Medico).filter(Medico.id == medico_id).first()
    if not medico:
        raise HTTPException(status_code=404, detail="Médico no encontrado")
    
    horarios = db.query(HorarioAtencion).filter(HorarioAtencion.medico_id == medico_id).all()
    
    return {
        "medico": medico.nombre,
        "especialidad": medico.especialidad,
        "horarios": [
            {
                "id": h.id,
                "dia_semana": h.dia_semana,
                "hora": h.hora.strftime("%H:%M") if h.hora else "N/A"
            }
            for h in horarios
        ]
    }

# ============================================================
# MODIFICAR HORARIO (opción 6)
# ============================================================
@router.put("/horarios/{horario_id}")
def modificar_horario(horario_id: int, datos: HorarioCreate, db: Session = Depends(get_db)):
    horario = db.query(HorarioAtencion).filter(HorarioAtencion.id == horario_id).first()
    if not horario:
        raise HTTPException(status_code=404, detail="Horario no encontrado")
    
    horario.dia_semana = datos.dia_semana
    horario.hora = datos.hora
    horario.medico_id = datos.medico_id
    
    db.commit()
    
    return {
        "ok": True,
        "mensaje": "Horario modificado correctamente"
    }

# ============================================================
# ELIMINAR HORARIO ESPECÍFICO
# ============================================================
@router.delete("/horarios/{horario_id}")
def eliminar_horario(horario_id: int, db: Session = Depends(get_db)):
    horario = db.query(HorarioAtencion).filter(HorarioAtencion.id == horario_id).first()
    if not horario:
        raise HTTPException(status_code=404, detail="Horario no encontrado")
    
    db.delete(horario)
    db.commit()
    
    return {
        "ok": True,
        "mensaje": "Horario eliminado correctamente"
    }

# ============================================================
# LISTAR TURNOS DETALLADOS
# ============================================================
@router.get("/turnos-detallados")
def get_turnos_detallados(db: Session = Depends(get_db)):
    query = db.query(
        Turno.id,
        Paciente.nombre.label("paciente"),
        Paciente.dni,
        Medico.nombre.label("medico"),
        Medico.especialidad,
        Turno.fecha
    ).join(Paciente, Turno.paciente_id == Paciente.id)\
     .join(Medico, Turno.medico_id == Medico.id)\
     .order_by(Turno.fecha.desc())
    
    resultados = query.all()
    
    return [
        {
            "id": r.id,
            "paciente": r.paciente,
            "dni": r.dni,
            "medico": r.medico,
            "especialidad": r.especialidad,
            "fecha": r.fecha.strftime("%d/%m/%Y %H:%M") if r.fecha else "N/A"
        }
        for r in resultados
    ]