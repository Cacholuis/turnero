from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from app.database import SessionLocal
from app.models import Turno, Paciente, Medico, HorarioAtencion
import json
from datetime import datetime

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
# MODIFICAR DATOS DEL MÉDICO
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
# ELIMINAR MÉDICO
# ============================================================
@router.delete("/medicos/{medico_id}")
def eliminar_medico(medico_id: int, db: Session = Depends(get_db)):
    medico = db.query(Medico).filter(Medico.id == medico_id).first()
    if not medico:
        raise HTTPException(status_code=404, detail="Médico no encontrado")
    
    turnos_reservados = db.query(Turno).filter(Turno.medico_id == medico_id).count()
    if turnos_reservados > 0:
        return {
            "ok": False,
            "mensaje": f"No se puede eliminar al Dr. {medico.nombre} porque tiene {turnos_reservados} turno(s) reservado(s). Primero debe cancelar esos turnos."
        }
    
    db.query(HorarioAtencion).filter(HorarioAtencion.medico_id == medico_id).delete()
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
# LISTAR HORARIOS DE UN MÉDICO
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
# MODIFICAR HORARIO
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
# ELIMINAR HORARIO
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

# ============================================================
# OBTENER TURNOS FILTRADOS POR MÉDICO
# ============================================================
@router.get("/turnos/medico/{medico_id}")
def get_turnos_por_medico(medico_id: int, db: Session = Depends(get_db)):
    medico = db.query(Medico).filter(Medico.id == medico_id).first()
    if not medico:
        raise HTTPException(status_code=404, detail="Médico no encontrado")
    
    query = db.query(
        Turno.id,
        Paciente.nombre.label("paciente"),
        Paciente.dni,
        Turno.fecha
    ).join(Paciente, Turno.paciente_id == Paciente.id)\
     .filter(Turno.medico_id == medico_id)\
     .order_by(Turno.fecha.desc())
    
    resultados = query.all()
    
    return {
        "medico": medico.nombre,
        "especialidad": medico.especialidad,
        "turnos": [
            {
                "id": r.id,
                "paciente": r.paciente,
                "dni": r.dni,
                "fecha": r.fecha.strftime("%d/%m/%Y %H:%M") if r.fecha else "N/A"
            }
            for r in resultados
        ]
    }

# ============================================================
# OBTENER TURNOS FILTRADOS POR FECHA
# ============================================================
@router.get("/turnos/fecha/{fecha}")
def get_turnos_por_fecha(fecha: str, db: Session = Depends(get_db)):
    try:
        fecha_obj = datetime.strptime(fecha, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Formato de fecha inválido. Usá YYYY-MM-DD")
    
    query = db.query(
        Turno.id,
        Paciente.nombre.label("paciente"),
        Paciente.dni,
        Medico.nombre.label("medico"),
        Medico.especialidad,
        Turno.fecha
    ).join(Paciente, Turno.paciente_id == Paciente.id)\
     .join(Medico, Turno.medico_id == Medico.id)\
     .filter(Turno.fecha.like(f"{fecha}%"))\
     .order_by(Turno.fecha.asc())
    
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

# ============================================================
# VERIFICAR CREDENCIAL DE MÉDICO
# ============================================================
@router.post("/verificar-credencial")
def verificar_credencial(medico_id: int, password: str):
    try:
        with open("medicos_auth.json", "r", encoding="utf-8") as f:
            credenciales = json.load(f)
        
        if str(medico_id) in credenciales and credenciales[str(medico_id)] == password:
            return {"ok": True, "mensaje": "Credencial válida"}
        else:
            return {"ok": False, "mensaje": "ID o contraseña incorrectos"}
    except Exception as e:
        return {"ok": False, "mensaje": f"Error al verificar credencial: {str(e)}"}

# ============================================================
# OBTENER AGENDA DEL DÍA PARA UN MÉDICO
# ============================================================
@router.get("/agenda/{medico_id}")
def get_agenda_medico(medico_id: int, db: Session = Depends(get_db)):
    medico = db.query(Medico).filter(Medico.id == medico_id).first()
    if not medico:
        raise HTTPException(status_code=404, detail="Médico no encontrado")
    
    hoy = datetime.now().strftime("%Y-%m-%d")
    
    query = db.query(
        Turno.id,
        Paciente.nombre.label("paciente"),
        Paciente.dni,
        Turno.fecha
    ).join(Paciente, Turno.paciente_id == Paciente.id)\
     .filter(Turno.medico_id == medico_id)\
     .filter(Turno.fecha.like(f"{hoy}%"))\
     .order_by(Turno.fecha.asc())
    
    resultados = query.all()
    
    return {
        "medico": medico.nombre,
        "especialidad": medico.especialidad,
        "fecha": hoy,
        "turnos": [
            {
                "id": r.id,
                "paciente": r.paciente,
                "dni": r.dni,
                "hora": r.fecha.strftime("%H:%M") if r.fecha else "N/A"
            }
            for r in resultados
        ]
    }

# ============================================================
# CAMBIAR CONTRASEÑA DE UN MÉDICO
# ============================================================
@router.post("/cambiar-password")
def cambiar_password(medico_id: int, password_actual: str, password_nueva: str):
    try:
        with open("medicos_auth.json", "r", encoding="utf-8") as f:
            credenciales = json.load(f)
        
        if str(medico_id) not in credenciales:
            return {"ok": False, "mensaje": "Este médico no tiene contraseña asignada"}
        
        if credenciales[str(medico_id)] != password_actual:
            return {"ok": False, "mensaje": "La contraseña actual es incorrecta"}
        
        credenciales[str(medico_id)] = password_nueva
        
        with open("medicos_auth.json", "w", encoding="utf-8") as f:
            json.dump(credenciales, f, indent=2, ensure_ascii=False)
        
        return {"ok": True, "mensaje": "Contraseña cambiada exitosamente"}
    except Exception as e:
        return {"ok": False, "mensaje": f"Error al cambiar contraseña: {str(e)}"}

# ============================================================
# LISTAR CREDENCIALES
# ============================================================
@router.get("/medicos-credenciales")
def listar_credenciales():
    try:
        with open("medicos_auth.json", "r", encoding="utf-8") as f:
            credenciales = json.load(f)
        return {"ok": True, "credenciales": credenciales}
    except FileNotFoundError:
        return {"ok": True, "credenciales": {}}
    except Exception as e:
        return {"ok": False, "mensaje": str(e)}

# ============================================================
# ASIGNAR CONTRASEÑA
# ============================================================
@router.post("/asignar-password")
def asignar_password(medico_id: int, password: str):
    try:
        with open("medicos_auth.json", "r", encoding="utf-8") as f:
            credenciales = json.load(f)
        
        credenciales[str(medico_id)] = password
        
        with open("medicos_auth.json", "w", encoding="utf-8") as f:
            json.dump(credenciales, f, indent=2, ensure_ascii=False)
        
        return {"ok": True, "mensaje": f"Contraseña asignada al médico ID {medico_id}"}
    except Exception as e:
        return {"ok": False, "mensaje": f"Error al asignar contraseña: {str(e)}"}

# ============================================================
# TRANSFERIR TURNOS
# ============================================================
@router.post("/transferir-turnos")
def transferir_turnos(medico_origen_id: int, medico_destino_id: int, db: Session = Depends(get_db)):
    medico_origen = db.query(Medico).filter(Medico.id == medico_origen_id).first()
    medico_destino = db.query(Medico).filter(Medico.id == medico_destino_id).first()
    
    if not medico_origen:
        raise HTTPException(status_code=404, detail="Médico de origen no encontrado")
    if not medico_destino:
        raise HTTPException(status_code=404, detail="Médico de destino no encontrado")
    
    hoy = datetime.now().strftime("%Y-%m-%d")
    turnos_futuros = db.query(Turno).filter(
        Turno.medico_id == medico_origen_id,
        Turno.fecha >= hoy
    ).all()
    
    cantidad = len(turnos_futuros)
    
    for turno in turnos_futuros:
        turno.medico_id = medico_destino_id
    
    db.commit()
    
    return {
        "ok": True,
        "mensaje": f"Se transfirieron {cantidad} turno(s) del Dr. {medico_origen.nombre} al Dr. {medico_destino.nombre}",
        "cantidad": cantidad
    }

# ============================================================
# OBTENER TODOS LOS TURNOS DE UN MÉDICO
# ============================================================
@router.get("/mis-turnos/{medico_id}")
def get_mis_turnos(medico_id: int, db: Session = Depends(get_db)):
    medico = db.query(Medico).filter(Medico.id == medico_id).first()
    if not medico:
        raise HTTPException(status_code=404, detail="Médico no encontrado")
    
    hoy = datetime.now().strftime("%Y-%m-%d")
    
    query = db.query(
        Turno.id,
        Paciente.nombre.label("paciente"),
        Paciente.dni,
        Turno.fecha
    ).join(Paciente, Turno.paciente_id == Paciente.id)\
     .filter(Turno.medico_id == medico_id)\
     .filter(Turno.fecha >= hoy)\
     .order_by(Turno.fecha.asc())
    
    resultados = query.all()
    
    return {
        "medico": medico.nombre,
        "especialidad": medico.especialidad,
        "turnos": [
            {
                "id": r.id,
                "paciente": r.paciente,
                "dni": r.dni,
                "fecha": r.fecha.strftime("%d/%m/%Y %H:%M") if r.fecha else "N/A"
            }
            for r in resultados
        ]
    }

# ============================================================
# LISTAR MÉDICOS POR ESPECIALIDAD
# ============================================================
@router.get("/medicos-por-especialidad/{especialidad}")
def get_medicos_por_especialidad(especialidad: str, excluir_id: int = None, db: Session = Depends(get_db)):
    query = db.query(Medico).filter(Medico.especialidad.ilike(f"%{especialidad}%"))
    
    if excluir_id:
        query = query.filter(Medico.id != excluir_id)
    
    medicos = query.all()
    
    return [
        {
            "id": m.id,
            "nombre": m.nombre,
            "especialidad": m.especialidad
        }
        for m in medicos
    ]

# ============================================================
# LISTAR ESPECIALIDADES ÚNICAS
# ============================================================
@router.get("/especialidades-unicas")
def get_especialidades_unicas(db: Session = Depends(get_db)):
    medicos = db.query(Medico).all()
    especialidades = list(set([m.especialidad for m in medicos if m.especialidad]))
    return {"especialidades": especialidades}