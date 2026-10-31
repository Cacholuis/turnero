from fastapi import FastAPI
from app.routes import turnos, pacientes, medicos, admin

app = FastAPI(
    title="Sistema de Turnos Hospitalario",
    description="API para gestión de turnos, pacientes y médicos",
    version="1.0.0"
)

# Incluir las rutas
app.include_router(pacientes.router, prefix="/pacientes", tags=["Pacientes"])
app.include_router(medicos.router, prefix="/medicos", tags=["Médicos"])
app.include_router(turnos.router, prefix="/turnos", tags=["Turnos"])
app.include_router(admin.router, prefix="/admin", tags=["Administración"])

@app.get("/")
def read_root():
    return {"mensaje": "API del Sistema de Turnos funcionando correctamente"}