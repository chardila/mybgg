# Discovery mode: tener en cuenta juegos ya jugados y cuánto

**Fecha:** 2026-07-11
**Repos afectados:** `mybgg` (Worker de chat) y `mybgg-wiki` (contenido + sync a KV)

## 1. Objetivo

El modo `discovery` del chat (`chat.html` + `worker/src/index.js`) ayuda al usuario a decidir qué jugar, pero hoy no sabe cuántas veces ya jugó cada juego de su colección. Se quiere que:

1. El asistente use el historial de partidas (`numplays`) como una señal más (junto con jugadores, tiempo, peso) para variar sus recomendaciones — inclinándose por juegos poco jugados o nunca jugados cuando encajan igual de bien con lo pedido, sin que esto anule otros criterios explícitos del usuario.
2. Cada vez que recomiende un juego, mencione cuántas veces ya se jugó (ej. "nunca lo jugaste" / "lo jugaste 3 veces").
3. Pueda responder preguntas directas sobre el historial (ej. "¿qué no he jugado?", "¿cuál jugué más?").

Alcance: solo se tiene en cuenta el conteo de partidas (`numplays`). Con quién se jugó (`previous_players`) queda fuera de esta iteración.

## 2. Arquitectura y flujo de datos

El dato `numplays` **ya existe y se mantiene actualizado solo**, en un pipeline distinto al que arma el catálogo del chat:

- `scripts/gamecache` (repo `mybgg`) hace fetch horario (workflow `.github/workflows/index.yml`) a la colección y partidas del usuario en BGG, y publica `gamecache.sqlite.gz`. Este sqlite tiene una tabla `games(id INTEGER PRIMARY KEY, numplays INTEGER, ...)` donde `id` es el `bgg_id`.
- Ese archivo es accesible públicamente (sin autenticación) vía `https://cors-proxy.mybgg.workers.dev/chardila/mybgg` — devuelve el gzip crudo del sqlite. Verificado manualmente: `id=432` (Take 5) trae `numplays=62`, consistente con la colección real.

El catálogo que ve el LLM en modo discovery, en cambio, se arma en otro pipeline completamente distinto:

- `scripts/build_catalog.py` (repo `mybgg-wiki`) lee el frontmatter de cada `games/*/index.md` (que ya incluye `bgg_id`, agregado por `wiki_writer.py` al importar el juego) y arma `catalog.json` con campos estáticos (`slug, name, players, weight, playing_time, mechanics, categories, edition, status, rank, base_game_slug, expansions`) — sin ningún dato de partidas.
- El workflow `.github/workflows/sync-to-kv.yml` (repo `mybgg-wiki`) corre `build_catalog.py`, sube `catalog.json` a la KV `WIKI` del Worker (clave `catalog`), y sincroniza el contenido del wiki. Hoy dispara solo con `push` a `main` o `workflow_dispatch`.
- `worker/src/index.js` lee esa clave `catalog` de KV y la reduce con `minimizeGame()` antes de inyectarla en el system prompt del modo discovery (optimización de costos ya existente).

**Decisión de diseño (punto de fusión):** en vez de duplicar la lógica de fetch a la colección/partidas de BGG dentro del compilador de wiki (que usa la API pública de BGG "thing", sin datos por usuario), `build_catalog.py` descarga y lee el `gamecache.sqlite.gz` ya existente y cruza por `bgg_id` para agregar `numplays` a cada entrada de `catalog.json`. Esto evita reimplementar fetch de colección+partidas (ya lo hace `scripts/gamecache/downloader.py`) y no requiere backfill de los ~100 juegos ya importados (sus `index.md` no necesitan tocarse).

**Frescura:** como `sync-to-kv.yml` solo corre en push, `numplays` quedaría congelado entre importaciones. Se agrega un trigger `schedule:` diario al workflow para que el catálogo (y por lo tanto `numplays`) se refresque aunque no haya cambios en el wiki. Tolerancia acordada: fresco dentro de ~1 día es suficiente para una herramienta de "qué juego para esta noche".

## 3. Cambios en `mybgg-wiki`

### `scripts/build_catalog.py`

Nueva función:

```python
import gzip
import sqlite3
import tempfile
import urllib.request

GAMECACHE_URL = "https://cors-proxy.mybgg.workers.dev/chardila/mybgg"

def fetch_numplays_by_bgg_id(url: str = GAMECACHE_URL) -> dict[int, int]:
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            compressed = resp.read()
        raw = gzip.decompress(compressed)
        with tempfile.NamedTemporaryFile(suffix=".sqlite") as tmp:
            tmp.write(raw)
            tmp.flush()
            conn = sqlite3.connect(tmp.name)
            rows = conn.execute("SELECT id, numplays FROM games").fetchall()
            conn.close()
        return {int(bgg_id): int(numplays or 0) for bgg_id, numplays in rows}
    except Exception as exc:
        print(f"WARNING: could not fetch numplays from gamecache ({exc}); defaulting to 0", file=sys.stderr)
        return {}
```

En `build_catalog()`:

```python
def build_catalog(wiki_root: Path) -> list[dict]:
    numplays_by_id = fetch_numplays_by_bgg_id()
    games = []
    by_slug: dict[str, dict] = {}
    for index_file in sorted(wiki_root.glob("games/*/index.md")):
        content = index_file.read_text(encoding="utf-8")
        fm = parse_frontmatter(content)
        if not fm:
            continue
        bgg_id = fm.get("bgg_id")
        game = {
            # ...campos existentes sin cambios...
            "numplays": numplays_by_id.get(int(bgg_id), 0) if bgg_id is not None else 0,
            "expansions": [],
        }
        games.append(game)
        by_slug[game["slug"]] = game
    # resto sin cambios (anidar expansiones)
    return games
```

Las expansiones anidadas **no** llevan `numplays` propio (quedan en `0` por defecto, sin agregarlo al dict de expansión) — confirmado que el propio `scripts/gamecache/downloader.py` tampoco trackea plays por expansión (`BoardGame(expansion_data)` se construye sin pasar `numplays`, default `0`), así que no hay dato real que propagar ahí.

Falla suave: si la descarga del sqlite falla, se loguea un warning por stderr y el catálogo se construye igual con `numplays=0` en todos los juegos — no se aborta el sync.

### `.github/workflows/sync-to-kv.yml`

Agregar trigger de cron:

```yaml
on:
  push:
    branches: [main]
  schedule:
    - cron: '0 8 * * *'
  workflow_dispatch:
```

Sin más cambios en el workflow — el paso `Build catalog.json` ya invoca el script actualizado.

## 4. Cambios en `mybgg` (Worker)

### `worker/src/index.js` → `minimizeGame()`

```javascript
function minimizeGame(game, isNested = false) {
  const out = {
    name: game.name,
    players: game.players,
    weight: game.weight,
    mechanics: game.mechanics,
    categories: game.categories,
    status: game.status,
    numplays: game.numplays ?? 0,
  };
  if (!isNested) {
    out.rank = game.rank;
    if (game.expansions?.length) {
      out.expansions = game.expansions.map((e) => minimizeGame(e, true));
    }
  }
  return out;
}
```

### `SYSTEM_PROMPTS.discovery`

Se agrega una instrucción al prompt existente (es y en), sin remover nada de lo ya validado sobre expansiones:

**Español** (nueva oración a insertar tras el párrafo de expansiones):
> "Cada entrada del catálogo incluye 'numplays': cuántas veces ya jugaste ese juego. Tenlo en cuenta como una señal más (junto con jugadores, tiempo, peso) para variar tus recomendaciones — inclínate por juegos poco jugados o nunca jugados cuando encajen igual de bien con lo que pide el usuario, pero no descartes un juego muy jugado si es claramente la mejor opción. Cuando recomiendes un juego, mencioná siempre cuántas veces ya lo jugó (por ejemplo: 'nunca lo has jugado' o 'lo has jugado 3 veces'). Si el usuario pregunta directamente por su historial de partidas (qué no ha jugado, qué jugó más), respondé usando este dato."

**English** (equivalente):
> "Each catalog entry includes 'numplays': how many times you've already played that game. Take it into account as one more signal (alongside players, time, weight) to vary your recommendations — lean toward suggesting games played little or never when they fit the request just as well, but don't rule out a heavily-played game if it's clearly the best fit. Whenever you recommend a game, always mention how many times it's been played (e.g. 'you've never played this' or 'you've played this 3 times'). If the user asks directly about their play history (what they haven't played, what they've played most), answer using this data."

## 5. Edge cases

- **`numplays` ausente o `0`:** se trata como "nunca jugado" — el asistente lo menciona igual ("nunca lo has jugado").
- **Falla de red al descargar el sqlite en `build_catalog.py`:** no rompe el sync; catálogo se construye con `numplays=0` para todos, se auto-corrige en el próximo run (diario o por push).
- **`bgg_id` faltante o inválido en algún `index.md`:** se trata como `numplays=0` para esa entrada (no debería ocurrir dado que `wiki_writer.py` siempre lo escribe, pero se maneja defensivamente).
- **Expansiones:** siempre `numplays=0`, consistente con el resto del pipeline (no hay dato real de plays por expansión disponible hoy en ningún lado).

## 6. Testing / verificación

- `worker/test/minimizeGame.test.js`: agregar caso que confirme que `numplays` pasa a través del minimizado (incluyendo default `0` cuando el campo falta en el input).
- `mybgg-wiki`: verificación manual de `build_catalog.py` — correr con un `gamecache.sqlite.gz` de prueba (o mockeando `fetch_numplays_by_bgg_id`) y confirmar el cruce por `bgg_id`, incluyendo el caso de fallo de red (debe degradar a `0`, no lanzar excepción).
- End-to-end manual: disparar `sync-to-kv.yml` vía `workflow_dispatch`, confirmar que `catalog.json` en KV trae `numplays` correctos vía `curl https://bgg.cardila.com/api/games`, y probar el chat en modo discovery preguntando "¿qué juego no he jugado mucho?" / "¿cuál es el que más jugué?".

## 7. Fuera de alcance

- `previous_players` (con quién jugó) — explícitamente descartado para esta iteración.
- Fetch en tiempo real desde el Worker en cada request de chat — se descartó por complejidad innecesaria dado que "fresco dentro de ~1 día" es suficiente.
- Backfill de `numplays` en el frontmatter de los `index.md` existentes — no es necesario porque el merge ocurre en `build_catalog.py`, no en el contenido del wiki.
