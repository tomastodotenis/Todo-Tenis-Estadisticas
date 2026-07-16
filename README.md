# Top Ventas — Todo Tenis & Running

PWA que lee recursivamente la carpeta de Drive (Año → Mes → Planillas → pestañas de día),
suma unidades vendidas por producto y muestra el ranking por día / semana / mes / rango,
con gráfico de barras o torta.

## Puesta en marcha

1. **Client ID de Google**
   Seguí los pasos de Google Cloud Console (proyecto nuevo → habilitar Drive API →
   pantalla de consentimiento → credenciales OAuth tipo "Aplicación web") y agregá como
   origen autorizado la URL donde vas a publicar esta carpeta
   (ej: `https://tomastodotenis.github.io`).

   Abrí `app.js` y reemplazá:
   ```js
   CLIENT_ID: "PONÉ_TU_CLIENT_ID_AQUI.apps.googleusercontent.com",
   ```
   por el Client ID real (termina en `.apps.googleusercontent.com`).

2. **Publicar**
   Subí esta carpeta a GitHub Pages (mismo mecanismo que usaste para el stock scanner).

3. **Primer uso**
   - Abrí la app, tocá "Conectar con Drive" e iniciá sesión con la cuenta que tiene
     la carpeta de ventas.
   - El ID de la carpeta raíz ya viene precargado (la que compartiste). Si alguna vez
     cambia, se edita desde el ícono ⚙.
   - Tocá "Actualizar datos": la primera vez va a recorrer todos los años/meses y puede
     tardar varios minutos según cuántas planillas haya. Las siguientes veces solo
     reprocesa los archivos que cambiaron (se guarda un cache local por planilla y fecha
     de modificación).

## Cómo interpreta las planillas

- Busca la fila de encabezado por texto ("Título de la publicación", "Unidades"), no por
  número de fila fija — así no importa si un mes tiene filas extra arriba (como pasó en
  Abril) y otro no.
- Cuenta cualquier fila que tenga producto + unidades, sin importar el estado de la venta
  (columna "Estado" no se usa para filtrar).
- Agrupa el ranking por **título de publicación** (junta talles/colores de un mismo
  producto).
- Ignora las filas resumen de "Paquete de N productos" (no tienen título propio) y cuenta
  cada producto individual del paquete por separado, que sí trae su propia fecha y
  unidades.

## Notas

- Todo el procesamiento ocurre en el navegador; no hay backend. El token de Google se
  pide en cada sesión (o cuando expira) via el botón "Conectar con Drive".
- El cache vive en `localStorage` del navegador — es por dispositivo, no se comparte
  entre el celu y la compu.
