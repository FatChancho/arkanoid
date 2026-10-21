# WebBreakout

Extensión de Chrome que convierte cualquier página web compatible en un escenario jugable de Arkanoid. ¡La página original permanece intacta y visible durante el juego!

## 📦 Características del MVP

- **Sin dependencias externas**: Usa CSS vanilla y JavaScript puro
- **Canvas transparente**: El juego se dibuja sobre la página web sin modificar el DOM original
- **Detección inteligente**: Identifica elementos visibles y crea bloques jugables
- **Física realista**: Rebotes contra paredes, pala y bloques con resistencia variable
- **Interfaz minimalista**: Popup simple para activar/desactivar el juego

## 🚀 Instalación y uso

### Paso 1: Cargar la extensión en Chrome

1. Abre Chrome y navega a `chrome://extensions`
2. Activa el modo de desarrollador (interruptor en la esquina superior derecha)
3. Haz clic en "Cargar descomprimida"
4. Selecciona la carpeta `arkanoid` (contendrá todos los archivos de la extensión)
5. Verás el ícono de WebBreakout en la barra de extensiones

### Paso 2: Usar WebBreakout

1. Abre cualquier página web que consideres compatible (evita páginas internas de Chrome como `chrome://settings`)
2. Haz clic en el ícono de WebBreakout en la barra de extensiones
3. En el popup que aparece, haz clic en "Activar WebBreakout"
4. ¡El juego comenzará! Usa el mouse para mover la pala y hacer rebotar la pelota contra los bloques
5. Cuando el juego termine, haz clic en "Desactivar WebBreakout" para regresar a la página normal

### ✅ Criterios de aceptación

- [x] Instalación local en Chrome sin errores
- [x] Activación desde el popup en páginas web normales
- [x] Bloques alineados con elementos visibles de la página (tarjetas, imágenes, etc.)
- [x] Juego funcional con pelota, pala y colisiones
- [x] Destrucción de bloques y puntuación
- [x] Reinicio de partida
- [x] Desactivación sin dejar elementos residuales
- [x] DOM original sin modificaciones permanentes

## 🛠️ Estructura del proyecto

```
arkanoid/
├── manifest.json          # Configuración de la extensión
├── popup.html             # Interfaz del popup
├── popup.css              # Estilos CSS vanilla para el popup
├── popup.js               # Lógica de activación/desactivación
├── content/
│   └── content.js         # Lógica principal del juego (se ejecuta en la página web)
└── README.md              # Este archivo
```

## 📝 Notas importantes

- La extensión no modifica, oculta ni elimina contenido de la página web original
- El juego solo se activa en páginas que tengan elementos visibles y de tamaño suficiente
- Se respetan los límites de rendimiento (máximo 50 bloques)
- No se requieren dependencias externas ni pasos de build
- Para desactivar el juego, haz clic en el botón del popup o recarga la página

## 🐞 Reportar problemas

Si encuentras algún problema, por favor reporta:

1. URL de la página donde occurs
2. Descripción del comportamiento inesperado
3. Captura de pantalla si es posible

¡Gracias por usar WebBreakout! 🎮