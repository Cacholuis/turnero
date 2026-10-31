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

class MedicoCreate(BaseModel):
    nombre: str
    especialidad: str

class HorarioCreate(BaseModel):
    medico_id: int
    dia_semana: str
    hora: str

@router.get("/medicos-lista")
def get_medicos(db: Session = Depends(get_db)):
    return db.query(Medico).all()

@router.post("/medicos")
def crear_medico(datos: MedicoCreate, db: Session = Depends(get_db)):
    nuevo = Medico(nombre=datos.nombre, especialidad=datos.especialidad)
    db.add(nuevo)
    db.commit()
    db.refresh(nuevo)
    return {"mensaje": "Médico creado exitosamente", "id": nuevo.id}

@router.post("/horarios")
def crear_horario(datos: HorarioCreate, db: Session = Depends(get_db)):
    nuevo = HorarioAtencion(medico_id=datos.medico_id, dia_semana=datos.dia_semana, hora=datos.hora)
    db.add(nuevo)
    db.commit()
    return {"mensaje": "Horario cargado exitosamente"}

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