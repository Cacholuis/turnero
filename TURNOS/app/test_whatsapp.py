import os
from dotenv import load_dotenv
# 🚨 ESTA LÍNEA ES LA QUE FALTA AGREGAR:
from app.whatsapp_service import enviar_notificacion_turno

load_dotenv()

# 1. Leemos el número del .env
numero_sucio = os.getenv("TO_WHATSAPP", "")

# 2. Eliminamos "whatsapp:" y cualquier símbolo (+, -, espacios) para que el puente lo valide bien
numero_destino = numero_sucio.replace("whatsapp:", "").replace("+", "").strip()

# 3. Mensaje para el paciente del hospital
mensaje_prueba = "¡Hola! Su turno en el hospital público ha sido confirmado exitosamente."

print(f"🚀 Enviando mensaje al número limpio: {numero_destino}")

# 4. Ejecuta el envío al puente local de Node.js (index.js)
exito = enviar_notificacion_turno(numero_destino, mensaje_prueba)

if exito:
    print("✅ ¡El puente procesó el mensaje correctamente!")
else:
    print("❌ Hubo un fallo en la comunicación con el puente.")
