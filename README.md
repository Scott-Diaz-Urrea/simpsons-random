# Randomizer de Episodios

App para elegir una carpeta de videos y reproducir episodios al azar sin repetir,
hasta agotar la lista. Reconoce nombres tipo `S01E02`, `1x02` o carpetas
"Temporada N"; si no reconoce el patrón, igual agrega el archivo con su nombre.

Tiene dos modos, y **la misma app detecta automáticamente cuál usar** — no hay
que elegir nada a mano:

## Modo local (sin instalar nada)

Abrí `index.html` (o la versión publicada en GitHub Pages) desde el mismo
dispositivo donde están los videos. Tocás "Elegir carpeta de episodios", el
navegador te pide acceso a esa carpeta (File System Access API, con un
selector alternativo en navegadores sin soporte) y listo — todo ocurre en el
navegador, ningún archivo se sube ni se envía a ningún servidor.

Sirve para ver los episodios en la misma compu/celular donde están guardados.

## Modo servidor (streaming a otro dispositivo)

Para ver los episodios desde el celular (u otro dispositivo) mientras los
archivos se quedan en la compu, corré el servidor incluido:

```bash
node server.js
```

Requiere **Node.js** instalado (18+ recomendado, no usa ninguna librería
externa — no hace falta `npm install`). Por defecto escucha en el puerto
`8090`; se puede cambiar con la variable de entorno `PORT`.

Al abrir `http://<IP-o-host-del-servidor>:8090/` desde cualquier dispositivo,
la app detecta el servidor automáticamente (`/api/episodes`) y transmite los
videos por streaming HTTP con soporte de "seek" (adelantar/rebobinar), en vez
de pedir una carpeta local.

### ⚠️ Este servidor no tiene autenticación

`server.js` no pide usuario ni contraseña — cualquiera que alcance el puerto
puede ver/descargar los videos. **Nunca lo expongas directo a internet**
(nada de port-forwarding en el router, ni túneles públicos tipo ngrok). Está
pensado para correr solo dentro de:

- tu WiFi de casa (acceso mientras estás en la misma red), o
- una red privada tipo **[Tailscale](https://tailscale.com/)** (gratis para uso
  personal) para poder verlo desde cualquier lugar sin exponer nada a
  internet: instalás Tailscale en la compu y en el celular, iniciás sesión con
  la misma cuenta en ambos, y accedés a `http://<IP-de-tailscale-de-la-compu>:8090/`
  desde donde estés — solo tus propios dispositivos, logueados en tu cuenta,
  pueden alcanzar ese servidor.

### Mantener la compu disponible

El servidor solo funciona mientras la compu está encendida (no dormida/en
suspensión) y `node server.js` sigue corriendo. En un laptop con Windows:

- `Configuración → Sistema → Energía y batería → Pantalla, suspensión y
  bloqueo` → "Nunca" en suspensión con corriente conectada.
- `Panel de Control → Opciones de energía → Elegir el comportamiento del botón
  de suspensión` → "No hacer nada" al cerrar la tapa, con corriente conectada.
