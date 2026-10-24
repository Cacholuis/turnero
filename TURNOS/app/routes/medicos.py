from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.database import SessionLocal
from app.models import Medico

router = APIRouter()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

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
    # Obtener todas las especialidades únicas de los médicos
    medicos = db.query(Medico).all()
    especialidades = set()
    for medico in medicos:
        if medico.especialidad:
            especialidades.add(medico.especialidad)
    
    # Convertir a lista y ordenar alfabéticamente
    especialidades_ordenadas = sorted(list(especialidades))
    
    return {
        "especialidades": especialidades_ordenadas,
        "total": len(especialidades_ordenadas)
    }
