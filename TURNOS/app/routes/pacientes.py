from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.database import SessionLocal
from app.models import Paciente
from pydantic import BaseModel

router = APIRouter()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# Esquema para recibir los datos desde el bot de WhatsApp
class PacienteCreateBot(BaseModel):
    nombre: str
    dni: str

@router.post("/")
def crear_paciente(datos: PacienteCreateBot, db: Session = Depends(get_db)):
    # 1. Verificar si ya existe para evitar duplicados
    existente = db.query(Paciente).filter(Paciente.dni == datos.dni).first()
    if existente:
        raise HTTPException(status_code=400, detail="El paciente con este DNI ya está registrado.")
    
    # 2. Crear el nuevo paciente
    nuevo = Paciente(
        nombre=datos.nombre.strip(), # .strip() elimina espacios accidentales al inicio/final
        dni=datos.dni.strip(),
        fecha_nacimiento="1900-01-01", # Valor por defecto
        telefono=None,
    )
    
    try:
        db.add(nuevo)
        db.commit()
        db.refresh(nuevo)
        
        return {
            "mensaje": f"Paciente {nuevo.nombre} registrado correctamente.", 
            "paciente": {"id": nuevo.id, "nombre": nuevo.nombre, "dni": nuevo.dni}
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Error de base de datos: {str(e)}")