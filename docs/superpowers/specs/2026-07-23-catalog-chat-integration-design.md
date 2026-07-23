# Integración catálogo (index.html) ↔ chat (chat.html)

**Fecha:** 2026-07-23
**Repo afectado:** `mybgg` (`index.html`, `app-sqlite.js`, `style.css`, `chat.html`)

## 1. Objetivo

Hoy `index.html` (catálogo buscable con filtros) y `chat.html` (asistente conversacional)
son dos páginas estáticas sin ningún enlace entre sí — ni `index.html` referencia
`chat.html`, ni viceversa. El usuario tiene que saber que `chat.html` existe y navegar
ahí manualmente.

Se agregan dos puntos de entrada al chat desde el catálogo:

1. Un enlace **"Chat about this game"** en cada tarjeta de juego expandida, que lleva
   directo a una sesión de deep-dive ya lista para ese juego específico.
2. Un botón general **"Ask the assistant"** en el header, para búsquedas más complejas
   de las que permiten los filtros/facets — lleva a discovery mode, arrastrando el texto
   que el usuario ya haya escrito en la caja de búsqueda normal, si lo hay.

**Alcance:** solo cambios de frontend estático (`index.html`, `app-sqlite.js`, `style.css`
para el punto 1; `chat.html` para leer los nuevos parámetros de URL). Sin cambios al
Worker (`worker/`) ni al pipeline de contenido (`scripts/compiler/`). Ambas páginas
siguen siendo archivos estáticos independientes servidos por GitHub Pages — la
integración es navegación normal (`<a href>` / `location.href`), sin iframe ni fetch
dinámico entre ellas.

## 2. Enlace por juego: "Chat about this game"

### 2.1 Markup (`index.html`)

Dentro de `#game-card-template`, en `.bottom-info`, se agrega un `.stat-item` nuevo,
paralelo al `.bgg-link-section` existente:

```html
<div class="stat-item chat-link-section">
  <span class="material-symbols-rounded icon-themed">forum</span>
  <a href="" class="chat-link">Chat about this game</a>
</div>
```

Reutiliza las clases `.stat-item` / `.icon-themed` ya definidas en `style.css` para que
se vea consistente con "View on BGG" — mismo tamaño de ícono, mismo espaciado. Sin
`target="_blank"`: es navegación dentro del sitio, misma pestaña.

### 2.2 Render (`app-sqlite.js`)

En la función que rellena la plantilla de la tarjeta, inmediatamente después del bloque
"Set BGG link" (que usa `game.id` para el link a BGG — línea ~1571 actual):

```js
// Set chat link
const chatLink = clone.querySelector('.chat-link');
if (chatLink && game.id) {
  const params = new URLSearchParams({ bgg_id: game.id, name: game.name });
  chatLink.href = `chat.html?${params.toString()}`;
}
```

`game.id` es el id numérico de BGG, ya usado hoy para "View on BGG" — es el único
identificador que la base SQLite del catálogo comparte con el catálogo del chat
(`/api/games`, que expone `bgg_id` por juego). `game.name` viaja también en la URL para
que `chat.html` tenga un nombre legible en caso de que el juego no esté todavía en el
wiki (ver §2.4).

### 2.3 `chat.html`: lectura de `bgg_id` al cargar

El bloque de init actual es:

```js
(async () => {
  const count = await loadGames();
  triggerOpeningMessage();
})();
```

Se reemplaza por lógica que primero revisa la query string una vez `allGames` está
poblado:

```js
(async () => {
  await loadGames();
  const params = new URLSearchParams(location.search);
  const bggId = params.get('bgg_id');
  const name = params.get('name');
  const q = params.get('q');

  if (bggId) {
    const game = allGames.find((g) => !g.base_game_slug && String(g.bgg_id) === bggId);
    if (game) {
      document.getElementById('game-select').value = game.slug;
      startDeepDive(game.slug, gameLabel(game), [], []);
      return;
    }
    triggerOpeningMessage();
    if (name) sendMessage(currentLanguage === 'en' ? `Tell me about ${name}` : `Cuéntame sobre ${name}`);
    return;
  }

  triggerOpeningMessage();
  if (q) sendMessage(q);
})();
```

El filtro `!g.base_game_slug` replica exactamente el que ya usa `loadGames()` para
poblar el `<select>` (línea 333 actual) — las tarjetas de `index.html` solo representan
juegos base (las expansiones se muestran como chips dentro de la tarjeta del juego
base, no como tarjetas propias), así que solo tiene sentido buscar coincidencia contra
entradas base del catálogo del chat.

### 2.4 Caso sin coincidencia (juego no sincronizado al wiki todavía)

Si `bgg_id` no aparece en `allGames` (el juego aún no tiene contenido en el wiki / no se
sincronizó a KV), se cae a discovery mode con su mensaje de apertura normal, y se
autoenvía `Tell me about ${name}` / `Cuéntame sobre ${name}` según `currentLanguage`
(default `'es'`). Esto reutiliza `sendMessage()` tal cual existe hoy — el texto pasa por
el mismo escape de HTML que ya aplica a lo que el usuario escribe a mano (línea 356
actual, `replace(/&/g, '&amp;')...`), así que no hay riesgo de inyección aunque `name`
venga de la URL sin validar.

### 2.5 Expansiones

Clic en "Chat about this game" siempre arranca deep-dive **solo con el juego base**,
sin auto-incluir expansiones poseídas — igual que si el usuario hubiera elegido el
juego en el dropdown de `chat.html` y hecho clic en "Empezar" sin marcar ningún
checkbox. Si quiere incluir expansiones, usa el selector normal del chat.

## 3. Botón general: "Ask the assistant"

### 3.1 Markup (`index.html`)

En `<header class="search">`, junto a `search-box` y `sort-by`:

```html
<button id="chat-cta" class="chat-cta" type="button">
  <span class="material-symbols-rounded icon-small">smart_toy</span>
  Ask the assistant
</button>
```

### 3.2 Comportamiento (`app-sqlite.js` o script inline en `index.html`)

No es un `<a href>` estático porque debe leer el valor *actual* de la caja de búsqueda
en el momento del clic, no en el momento de cargar la página:

```js
document.getElementById('chat-cta').addEventListener('click', () => {
  const text = document.getElementById('search-input')?.value.trim() || '';
  window.location.href = text
    ? `chat.html?q=${encodeURIComponent(text)}`
    : 'chat.html';
});
```

### 3.3 `chat.html`: lectura de `q`

Ya cubierto en el bloque de init de §2.3 — si no hay `bgg_id` pero sí `q`, se muestra el
mensaje de apertura de discovery normal y se autoenvía `q` con `sendMessage(q)`, igual
patrón que `startTeach()` ya usa para autoenviar su mensaje inicial.

## 4. Manejo de errores

No se introduce ningún estado de error nuevo — ambos flujos degradan a estados que
`chat.html` ya maneja hoy:

- Si `/api/games` falla, `loadGames()` ya cae en su `catch` (deshabilita el `<select>`,
  muestra `'No se pudo cargar la lista de juegos.'`) — la lógica de `bgg_id`/`q` corre
  después y simplemente no encuentra coincidencia, cayendo al flujo de discovery
  (con o sin autoenvío según haya `name`/`q`).
- Si `bgg_id` viene pero el juego no está en el catálogo del chat → discovery con
  fallback (§2.4), no un error visible al usuario.
- Si no hay ningún parámetro en la URL (navegación directa a `chat.html`, como hoy) →
  comportamiento idéntico al actual, discovery mode en blanco.

## 5. Testing

Sin suite automatizada que cubra `index.html`/`chat.html`/`app-sqlite.js` (patrón
existente del proyecto). Verificación manual en navegador:

1. Tarjeta de un juego **con** contenido en el wiki → clic en "Chat about this game" →
   aterriza en deep-dive, mensaje de apertura ya mostrado, listo para escribir.
2. Tarjeta de un juego **sin** contenido en el wiki → clic → aterriza en discovery con
   el mensaje `Tell me about <nombre>` ya autoenviado y su respuesta en curso.
3. Botón "Ask the assistant" con texto ya escrito en la búsqueda del catálogo → discovery
   con ese texto autoenviado.
4. Botón "Ask the assistant" con la caja de búsqueda vacía → discovery en blanco, igual
   que hoy al entrar directo a `chat.html`.
5. Confirmar que ninguno de los flujos existentes de `chat.html` (dropdown manual,
   deep-dive, teach, reset a discovery) se rompe.
