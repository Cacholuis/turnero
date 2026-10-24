from fastapi import FastAPI
from app.routes import turnos, pacientes, medicos

app = FastAPI(
    title="Sistema de Turnos Hospitalarios",
    description="API para gestionar turnos, pacientes y médicos en el Hospital Público El Mollar",
    version="1.0.0"
)

# Registrar las rutas
app.include_router(turnos.router, prefix="/turnos", tags=["Turnos"])
app.include_router(pacientes.router, prefix="/pacientes", tags=["Pacientes"])
app.include_router(medicos.router, prefix="/medicos", tags=["Medicos"])

@app.get("/")
def root():
    return {"mensaje": "✅ API del Hospital Público El Mollar funcionando correctamente"}
