# WebBreakout

Extensión de Chrome (Manifest V3) que convierte la página actual en un escenario de Arkanoid destructible. La página se captura y se juega sobre esa captura: cada objetivo es una **pieza visual coherente** (un logo, una imagen, un titular, un botón, una tarjeta, un fondo), no una celda de una cuadrícula.

## Características

- **Sin dependencias externas**: JavaScript y CSS puros, sin paso de build.
- **Objetivos semánticos**: detecta logos (img, SVG, `background-image`), imágenes, SVG, canvas, titulares, bloques de texto, enlaces, botones y controles, tarjetas y fondos a partir del DOM, los estilos calculados y la geometría.
- **Destrucción por regiones**: los objetivos pequeños caen de un impacto; los grandes se parten en regiones y necesitan varios.
- **Sin daños colaterales**: cada región pertenece a un único objetivo (el de la capa más alta). Destruir una imagen no borra el titular que está encima.
- **Fragmentos** con la textura y los colores de la captura original, que se mueven y se desvanecen.
- **Progreso**: objetivos destruidos y restantes, porcentaje de superficie destruida (sin contar dos veces las zonas solapadas), puntuación y vidas.
- **Objetos que caen según la puntuación** (power-ups): bola triple, barra grande y láser. Ver «Objetos» más abajo.
- **Sonido sintetizado** (Web Audio, sin archivos de audio): un rebote distinto para pared, pala y objetivo, y una explosión por cada región que se rompe, más larga y grave cuanto más área rompe el impacto. Tecla `M` para silenciar.
- Pelota a velocidad constante con paso de física fijo (independiente de los Hz del monitor), 3 vidas, Game Over, victoria y reinicio.
- Controles: ratón o táctil; flechas / `A` `D`; **clic izquierdo o `Espacio`: disparar (con el láser)**; `R` reinicia; `M` sonido; `Esc` sale; clic para reiniciar tras Game Over o victoria.
- Compatible con `devicePixelRatio` y con el redimensionado de la ventana.

## Instalación y uso

1. Abre `chrome://extensions` y activa el **modo de desarrollador**.
2. Pulsa **Cargar descomprimida** y elige la carpeta de la extensión.
3. Abre una página `http(s)://` normal (Chrome no permite extensiones en `chrome://` ni en la Chrome Web Store).
4. Pulsa el icono de WebBreakout y **Activar WebBreakout**. Puedes cerrar el popup: el juego sigue.
5. Para salir: `Esc`, o abre el popup y pulsa **Desactivar WebBreakout**. La página queda como estaba.

## Estructura

```
├── manifest.json     Configuración (MV3)
├── popup.html/.css   Interfaz del popup
├── popup.js          Captura (captureVisibleTab), inyección y mensajes
├── content.js        Orquestador en la página: protocolo de mensajes, arranque y limpieza
├── scene.js          Detección y agrupación de objetivos (solo lectura del DOM)
├── destruction.js    Máscaras, regiones, colisión, capa del escenario y muestreo de colores
├── audio.js          Efectos de sonido sintetizados (rebotes y explosiones)
└── game.js           Pelota, pala, vidas, entrada, efectos, HUD y ciclo de vida
```

`popup.js` inyecta los cinco scripts en este orden: `scene.js`, `destruction.js`, `audio.js`, `game.js`, `content.js`. Comparten un espacio de nombres (`__WebBreakout`) en el mundo aislado del content script. La captura se pide siempre desde el popup; `content.js` nunca llama a `chrome.tabs`.

### Protocolo de mensajes (popup → content)

| Acción | Respuesta |
|---|---|
| `getStatus` | `{ ok, active, state, score, lives, destroyedTargets, remainingTargets, totalTargets, percentDestroyed }` |
| `activate` + `screenshot` | `{ ok:true, active:true }` o `{ ok:false, error }` |
| `deactivate` | `{ ok:true, active:false }` |
| `restart` | `{ ok, active }` |

Errores contemplados: página no permitida, fallo de captura, fallo de inyección, captura inválida o con distinta proporción que la ventana, ausencia de objetivos o de superficie jugable, y excepción dentro del bucle del juego (se limpia sola).

## Cómo se deciden los objetivos (`scene.js`)

1. **Hojas atómicas** (nunca se dividen): `img`, `video`, `canvas`, `svg`, `object/embed/iframe`, controles (`button`, `input`, `select`, `textarea`, `[role=button]`…) y `[role=img]`.
2. **Bloque de texto**: un elemento de bloque con texto en línea es una pieza que absorbe sus `span`, `a`, `b`… Su forma son las líneas de texto, no la caja entera. Un menú de enlaces en línea se separa en un objetivo por enlace.
3. **Tarjeta**: contenedor con decoración propia (fondo, borde en 3+ lados, sombra o imagen de fondo), de tamaño de tarjeta (≤ 38 % del viewport y ≤ 92 % de ancho) y con 2 a 14 piezas, que no sobresalgan de su caja ni sean ya tarjetas. Un contenedor con varias tarjetas no se agrupa: se aplana.
4. **No se agrupan** `body`/`html`, contenedores sin decoración ni contenedores demasiado grandes. Un contenedor grande con imagen de fondo (o fondo sólido distinto del de la página) añade además una pieza `background` (máximo 6).
5. **Elementos vacíos con imagen de fondo CSS** (logos con sprite, miniaturas) son imagen o logo.
6. **Se ignoran**: `display:none`, `opacity` ≈ 0, `visibility:hidden`, fuera del viewport o recortados por `overflow`, tapados por otro elemento (`elementFromPoint`) y más pequeños de 18×12 px.
7. **Duplicados**: dos piezas con IoU ≥ 0,8 son la misma; se conserva la de tipo más específico. Máximo 250 objetivos.
8. **Logos**: por nombre (id, clase, `alt`, `title`, `aria-label`, `<title>` del SVG, ruta de la imagen), por coincidir su nombre accesible con el título o el dominio del sitio, o por ser un medio dentro de un enlace a la portada en la parte alta de la página.

## Objetos (power-ups)

Cada **60 puntos** cae una cápsula desde el punto del impacto que cruzó el umbral (10 puntos por región destruida, +20 al terminar un objetivo de varias regiones). Los tipos salen de una bolsa barajada: cada tres cápsulas aparecen los tres tipos, en orden aleatorio. Se recogen con la pala; si caen fuera no pasa nada.

| Cápsula | Efecto |
|---|---|
| Tres puntos (amarilla) | **Bola triple**: cada bola se divide en tres (±22°), hasta un máximo de 9. Perder una bola no cuesta vida; solo se pierde una vida al perder la última. |
| Flecha doble (azul) | **Barra grande**: la pala pasa de 110 a 190 px durante 20 s. |
| Dos barras (roja) | **Láser** durante 15 s: clic izquierdo (o `Espacio`, o tocar la pantalla) dispara 2 proyectiles desde los extremos de la pala. Mantener pulsado repite el disparo cada 14 pasos (~0,23 s). Cada proyectil destruye como mucho una región, igual que la pelota, y puntúa igual. |

- Recoger un objeto del mismo tipo reinicia su temporizador (no se acumulan).
- Perder una vida o reiniciar elimina los efectos, las cápsulas en caída y los proyectiles.
- El panel de efectos muestra el número de bolas y el tiempo restante de cada efecto.
- Todos los valores (`powerupEvery`, duraciones, `maxBalls`, ancho de la barra grande, enfriamiento...) están en `CONFIG` al inicio de `game.js`; `powerupEvery: 0` desactiva los objetos.

## Sonido y política de autoplay

Chrome no deja sonar a una página hasta que el usuario interactúa con ella (un clic o una tecla; mover el ratón no cuenta), y pulsar el botón del popup **no** cuenta como interacción con la página. Por eso:

- Si ya habías hecho clic o pulsado una tecla en esa página, el sonido funciona desde el primer momento.
- Si no, el panel muestra «Haz clic o pulsa una tecla para activar el sonido» y se activa con el primer clic o tecla.
- Hasta entonces no se crea ningún `AudioContext` y no se encola ningún sonido (así no suenan todos de golpe al activarse).
- La salida lleva compresor y limitador suave, con un máximo de 8 explosiones simultáneas y una separación mínima entre rebotes, para que no sature.
- El `AudioContext` se cierra al desactivar el juego.

## Limitaciones conocidas

- **Silueta aproximada.** Para logos, SVG, canvas y PNG/SVG pequeños la forma se obtiene de la captura (celdas que difieren del color de fondo, cerrando huecos de ~6 px). Solo funciona si el fondo alrededor es uniforme y con contraste suficiente (una letra amarilla sobre fondo amarillo queda fuera). En otro caso se usa la caja con sus esquinas redondeadas. No es el contorno vectorial exacto.
- **Resolución de máscara** de 1 a 4 px CSS (2 px en un portátil típico); el borrado se redondea a píxeles de la captura, con hasta 1 px de desviación en los bordes.
- **Línea de la pala.** Lo que queda por debajo de la pala (por ejemplo el pie de página de Google) es inalcanzable: no cuenta como destruible y permanece intacto.
- **Los objetos solo caen de impactos** (de bola o de proyectil), nunca de otras fuentes, y el ritmo depende de la puntuación: en una página con pocos objetivos caerán pocos.
- **Orden de pintado aproximado**: las capas son por tipo (fondo < imagen < tarjeta < logo/control < texto), no el `z-index` real.
- **No se recorre Shadow DOM**, ni pseudo-elementos (`::before/::after`) ni fuentes de iconos. El contenido de `iframe` se trata como una sola pieza.
- **Redimensionado**: la captura no se puede repetir desde la página, así que el escenario se escala uniformemente (con barras oscuras si cambia la proporción) en lugar de recalcular los objetivos.
- El overlay captura el ratón y las teclas del juego mientras está activo; la página no recibe esos eventos.
- Se recorren como máximo 30 000 elementos del DOM.

## Reportar problemas

Indica la URL, el tamaño de la ventana, qué esperabas y qué ocurrió, y una captura si es posible.
