import logging

import requests

logger = logging.getLogger(__name__)


def enviar_notificacion_turno(telefono: str, mensaje: str) -> bool:
    try:
        response = requests.post(
            "http://127.0.0.1:3000/send",
            json={"telefono": telefono, "mensaje": mensaje},
            timeout=5,
        )
        response.raise_for_status()
    except requests.RequestException:
        logger.exception("No se pudo enviar la notificación al conector local de WhatsApp")
        return False

    return True
