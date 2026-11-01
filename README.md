# WebBreakout

Extensión de Chrome (Manifest V3) que convierte la página actual en un escenario de Arkanoid destructible. La página se captura y se juega sobre esa captura: cada objetivo es una **pieza visual coherente** (un logo, una imagen, un titular, un botón, una tarjeta, un fondo), no una celda de una cuadrícula.

## Características

- **Sin dependencias externas**: JavaScript y CSS puros, sin paso de build.
- **Objetivos semánticos**: detecta logos (img, SVG, `background-image`), imágenes, SVG, canvas, titulares, bloques de texto, enlaces, botones y controles, tarjetas y fondos a partir del DOM, los estilos calculados y la geometría.
- **Destrucción por regiones**: los objetivos pequeños caen de un impacto; los grandes se parten en regiones y necesitan varios.
- **Sin daños colaterales**: cada región pertenece a un único objetivo (el de la capa más alta). Destruir una imagen no borra el titular que está encima.
- **Fragmentos** con la textura y los colores de la captura original, que se mueven y se desvanecen.
- **Banner retro fuera del tablero**: puntos, vidas, objetivos destruidos y restantes, porcentaje de superficie destruida (sin contar dos veces las zonas solapadas) y efectos activos con su tiempo, en una franja superior con tipografía de píxeles. No tapa la página: el tablero se escala para caber debajo, dentro de un marco neón.
- **Objetos que caen según la puntuación** (power-ups): bola triple, barra grande, láser automático y bola grande. Ver «Objetos» más abajo.
- **Ratón capturado, solo lateral**: el primer clic captura el ratón; el cursor no puede salir de la ventana y solo cuenta el movimiento horizontal. Ver «Ratón capturado».
- **Saque con clic**: la bola espera pegada a la pala (con un aviso «CLIC PARA LANZAR») y no se mueve hasta que haces clic. También con `Espacio` o tocando la pantalla.
- **Revelar bloques (`B`)**: resalta en rojo, con halo desenfocado, lo que queda por destruir. Útil cuando quedan pocos.
- **Aspecto arcade**: pala con contorno oscuro y extremos de color, bola y cápsulas con contorno (se ven sobre páginas claras y oscuras), avisos flotantes y destello al recoger un objeto.
- **Música**: *Arcade Kid* de fondo mientras juegas (en bucle) y una marcha fúnebre de 8 bits en el Game Over. Ver «Música».
- **Sonido sintetizado** (Web Audio, sin archivos de audio): un rebote distinto para pared, pala y objetivo, y una explosión por cada región que se rompe, más larga y grave cuanto más área rompe el impacto. Tecla `M` para silenciar.
- Pelota a velocidad constante con paso de física fijo (independiente de los Hz del monitor), 3 vidas, Game Over, victoria y reinicio.
- Controles: ratón o táctil; flechas / `A` `D`; **clic, `Espacio` o toque: lanzar la bola**; **`B`: revelar bloques**; `R` reinicia; `M` sonido; `Esc` suelta el ratón y, pulsada otra vez, sale; clic para reiniciar tras Game Over o victoria.
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
├── audio.js          Efectos de sonido sintetizados y reproductor de música
├── music/            arcade-kid.mp3 y marcha-funebre.mp3 (se cargan desde la extensión)
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

## Ratón capturado

El primer clic de la partida lanza la bola y **captura el ratón** (API de bloqueo del puntero): el cursor se oculta y no puede salir de la ventana, así que la pala sigue respondiendo aunque muevas el ratón mucho más allá del borde. Mientras está capturado solo se usa el movimiento **horizontal**; el vertical se ignora. La pala sigue al ratón 1:1 (con la escala del tablero y también en pantallas de alta densidad). Chrome muestra su propio aviso («pulsa Esc para mostrar el cursor»).

- **Esc**: la primera pulsación solo **libera el ratón**; otra pulsación sale del juego. Tras soltarlo, el cursor reaparece, la pala vuelve al control absoluto (sigue la posición del cursor) y un aviso parpadeante pide *«CLIC PARA CAPTURAR EL RATÓN»*. El clic recaptura sin lanzar otra bola.
- Si cambias de pestaña o de ventana, el navegador también libera el ratón; al volver, el mismo aviso.
- **Sin captura posible** (página en un iframe sin permiso, navegador sin soporte...): todo funciona como antes, con el cursor visible y control absoluto.
- Las flechas / `A` `D` siguen funcionando capturado, y el ratón retoma desde donde dejó la pala (sin saltos).
- **Defensas**: algunos navegadores emiten un movimiento enorme espurio al conceder la captura (la pala saltaría al borde y se perdería la bola). Por eso se ignora el movimiento durante los primeros 150 ms tras la captura, el movimiento absoluto mientras la captura está pendiente (máx. 300 ms), y cualquier evento suelto de más de max(300 px, 45 % del ancho de la ventana). Las tres cosas se pueden ajustar en `CONFIG` (`lockSettleMs`, `lockPendingMs`, `lockMinJump`), igual que la sensibilidad (`mouseSensitivity`, por defecto 1) o desactivar la captura (`pointerLock: false`).

## Saque y revelado de bloques

**Saque.** Al empezar la partida, y también tras perder una vida, la bola espera sobre la pala y acompaña a la pala mientras la mueves. Se lanza con un clic izquierdo, con `Espacio` o tocando la pantalla; después, más clics no hacen nada. El mismo clic captura el ratón (ver arriba). En Game Over, el clic reinicia la partida y la bola nueva también espera (ese mismo clic no la lanza). Para volver al saque automático a los 40 pasos, pon `serveWaitsForClick: false` en `CONFIG` de `game.js`.

**Revelar (`B`).** Es un interruptor: `B` lo activa y otra pulsación lo apaga (mantener la tecla no parpadea). Resalta exactamente las regiones vivas, las mismas que usa la colisión: un halo rojo desenfocado por fuera del borde y un tinte suave por dentro, que deja ver la página. Lo que ya está destruido no se resalta, y se actualiza al instante tras cada impacto. El banner indica `B: VER BLOQUES` / `B: BLOQUES ON`. La capa se cachea a media resolución y solo se reconstruye cuando se destruye algo (≈1 ms por fotograma; unos 30 ms al reconstruirla en 1920×1080 con 500 regiones).

## Objetos (power-ups)

Cada **150 puntos** cae una cápsula desde el punto del impacto que cruzó el umbral (10 puntos por región destruida, +20 al terminar un objetivo de varias regiones). Medido con un bot que recoge casi todo: unos 3 objetos en una página de 40 regiones y 1 en una de 14. Los tipos salen de una bolsa barajada que se rellena cada 4 cápsulas, así que en cada bolsa aparecen los cuatro tipos en orden aleatorio (al enlazar dos bolsas, el último y el primero pueden repetirse). Se recogen con la pala; si caen fuera no pasa nada.

| Cápsula | Efecto |
|---|---|
| Tres puntos (amarilla) | **Bola triple**: cada bola se divide en tres (±22°), hasta un máximo de 9. Perder una bola no cuesta vida; solo se pierde una vida al perder la última. |
| Flecha doble (azul) | **Barra grande**: la pala pasa de 110 a 190 px durante 20 s. |
| Círculo (verde) | **Bola grande**: el radio de todas las bolas pasa de 7 a 13 px durante 20 s, también el de las que nazcan mientras dure (por ejemplo con una bola triple). Crece y vuelve a su tamaño poco a poco. Toca los bloques unos 6 px antes y es más fácil de recoger con la pala, pero sigue destruyendo una sola región por contacto. |
| Dos barras (roja) | **Láser automático** durante 15 s: sin pulsar nada, dispara 2 proyectiles desde los extremos de la pala cada 24 pasos (0,4 s). Cada proyectil destruye como mucho una región, igual que la pelota, y puntúa igual. |

- Recoger un objeto del mismo tipo reinicia su temporizador (no se acumulan).
- Perder una vida o reiniciar elimina los efectos, las cápsulas en caída y los proyectiles.
- El banner muestra el número de bolas y el tiempo restante de cada efecto (parpadea en los últimos 3 s).
- Al recoger un objeto, la pala destella y aparece un aviso flotante («BARRA GRANDE», «BOLA TRIPLE», «LÁSER AUTOMÁTICO»).
- Equilibrio: el láser acorta mucho las partidas, sobre todo si cae pronto. Si te parece excesivo, baja `laserSteps` o sube `laserCooldownSteps` en `CONFIG`.
- Todos los valores (`powerupEvery`, duraciones, `maxBalls`, `bigBallRadius`, ancho de la barra grande, enfriamiento...) están en `CONFIG` al inicio de `game.js`; `powerupEvery: 0` desactiva los objetos. Para más o menos objetos, sube o baja `powerupEvery`: con 60 caían unos 9 en una página de 40 regiones; con 200 una página pequeña se queda sin ninguno.

## Música

- **Mientras juegas**: *Arcade Kid* (128 s) en bucle. Al **perder la última vida** se funde con la **marcha fúnebre** (5 s, suena una vez y no se repite). Al **reiniciar** vuelve *Arcade Kid*. Perder una vida que no es la última no cambia la música, y en la victoria sigue la música de juego.
- **`M`** silencia música y efectos a la vez. Con la pestaña oculta el audio se pausa y se reanuda al volver, igual que el bucle del juego.
- **Mezcla**: la marcha viene masterizada unos 8 dB más fuerte que *Arcade Kid* (−7,8 frente a −15,8 LUFS, con picos en 0 dBFS), así que cada pista tiene su ganancia (`MUSIC` en `audio.js`). Medido sobre los archivos reales: el fondo queda en ≈ −30 dBFS de RMS y la marcha en ≈ −17 dBFS, sin recortes. **Los efectos sobresalen ≥ 8 dB sobre la música en su banda de frecuencias** (rebotes, láser, recoger objeto); si subes la ganancia del fondo, vuelve a comprobarlo para no tapar los rebotes.
- **Carga**: los MP3 van dentro de la extensión (`music/`, declarados en `web_accessible_resources` del manifest). Se cargan con `fetch` desde el content script y se reproducen con Web Audio, no con un `<audio>`: así funciona incluso en páginas con una política CSP estricta (probado con `default-src 'none'`). La carga es perezosa (al empezar a jugar) y se decodifica a 32 kHz para ocupar unos **32 MB** en la pestaña (49 MB a 48 kHz); se liberan al salir.
- **Autoplay**: como con los efectos, Chrome no deja sonar hasta que haces clic o pulsas una tecla en la página. La música empieza en cuanto eso ocurre; el primer clic (que lanza la bola) basta.
- **Bucle**: *Arcade Kid* tiene ~0,8 s de silencio al principio y ~1 s al final, así que en la costura del bucle hay una pausa natural.
- Si falla la carga (archivo ausente, CSP que bloquee la extensión...), el juego sigue sin música y con efectos.

### Créditos de la música

- **Arcade Kid** («Slower Tempo», 2020-04-24): David Renda, FesliyanStudios.com (según el nombre del archivo y sus etiquetas).
- **Marcha fúnebre 8 bits**: «composiia» (según el nombre del archivo).

No he podido comprobar sus licencias. Revisa las condiciones de uso de cada una (por ejemplo, si exigen atribución) antes de publicar o distribuir la extensión.

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
- **La bola en espera puede nacer dentro de un objetivo**: si la página tiene un elemento pegado al borde inferior (por ejemplo, el pie de Google), la bola, que espera sobre la pala, queda dentro de él. Al lanzarla destruye esa región al instante y puede rebotar hacia abajo. Es la misma geometría de siempre; ahora se nota porque la bola espera a la vista.
- **Los objetos solo caen de impactos** (de bola o de proyectil), nunca de otras fuentes, y el ritmo depende de la puntuación: en una página con pocos objetivos caerán pocos.
- **Orden de pintado aproximado**: las capas son por tipo (fondo < imagen < tarjeta < logo/control < texto), no el `z-index` real.
- **No se recorre Shadow DOM**, ni pseudo-elementos (`::before/::after`) ni fuentes de iconos. El contenido de `iframe` se trata como una sola pieza.
- **Tablero algo más pequeño**: para dejar sitio al banner, la página capturada se reduce un 7-11 % (64 px de banner en ventanas de 1000 px o más de ancho; 34 px en las más estrechas). Al redimensionar la ventana, la captura no se puede repetir desde la página, así que el tablero se vuelve a escalar uniformemente (con barras oscuras si cambia la proporción) en lugar de recalcular los objetivos.
- **Tamaño de la extensión**: los dos MP3 suman unos 5,3 MB. Al declararlos como `web_accessible_resources` para `<all_urls>`, cualquier web puede detectar que la extensión está instalada (es la limitación habitual de este mecanismo).
- **Tipografía del banner**: fuente de píxeles propia, solo mayúsculas, dígitos y la puntuación necesaria (con acentos Á É Í Ó Ú). En ventanas muy estrechas el banner descarta lo opcional (tag de láser, bolas, aviso de sonido) y, si hace falta, acorta o quita la barra de progreso.
- El overlay captura el ratón y las teclas del juego mientras está activo; la página no recibe esos eventos.
- Se recorren como máximo 30 000 elementos del DOM.

## Reportar problemas

Indica la URL, el tamaño de la ventana, qué esperabas y qué ocurrió, y una captura si es posible.
