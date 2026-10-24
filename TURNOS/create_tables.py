import os
from dotenv import load_dotenv

# Forzar carga del .env desde la raíz del proyecto
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))

from app.database import Base, engine
from app import models

print("📌 Creando tablas en la base de datos...")
Base.metadata.create_all(bind=engine)
print("✅ Tablas creadas correctamente.")
