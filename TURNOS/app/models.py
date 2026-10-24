from sqlalchemy import Column, Integer, String, Date, Time, ForeignKey, DateTime
from sqlalchemy.orm import declarative_base

# Base declarativa de SQLAlchemy
Base = declarative_base()


class Paciente(Base):
    __tablename__ = "pacientes"

    id = Column(Integer, primary_key=True, index=True)
    nombre = Column(String(100), nullable=False)
    dni = Column(String(20), unique=True, index=True, nullable=False)
    fecha_nacimiento = Column(Date, nullable=True)
    telefono = Column(String(20), nullable=True)


class Medico(Base):
    __tablename__ = "medicos"

    id = Column(Integer, primary_key=True, index=True)
    nombre = Column(String(100), nullable=False)
    especialidad = Column(String(100), nullable=False)


class Turno(Base):
    __tablename__ = "turnos"

    id = Column(Integer, primary_key=True, index=True)
    paciente_id = Column(Integer, ForeignKey("pacientes.id"), nullable=False)
    medico_id = Column(Integer, ForeignKey("medicos.id"), nullable=False)
    fecha = Column(DateTime, nullable=False)


class HorarioAtencion(Base):
    __tablename__ = "horarios_atencion"

    id = Column(Integer, primary_key=True, index=True)
    # ondelete="CASCADE" asegura que si se borra un médico, se borren sus horarios
    medico_id = Column(Integer, ForeignKey("medicos.id", ondelete="CASCADE"), nullable=False)
    dia_semana = Column(String(20), nullable=False)  # Ej: 'lunes', 'martes', 'miercoles'
    hora = Column(Time, nullable=False)              # Ej: '08:00:00'