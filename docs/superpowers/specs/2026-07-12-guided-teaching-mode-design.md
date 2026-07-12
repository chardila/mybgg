# Modo de enseñanza guiada ("Enséñame a jugar")

**Fecha:** 2026-07-12
**Repos afectados:** `mybgg` (Worker + `chat.html`) y `mybgg-wiki` (contenido, vía `scripts/compiler`)

## 1. Objetivo

El chat hoy solo tiene dos modos: `discovery` (qué jugar) y `deep_dive` (Q&A experto una vez elegido el juego). `deep_dive` es un modo pasivo: el usuario pregunta, el bot responde con cita de fuente (📖/🧠). Funciona bien para quien ya conoce el hobby y tiene preguntas puntuales (el caso de uso actual del usuario).

No sirve para enseñarle a jugar desde cero a alguien sin experiencia (hijos, esposa). Para eso se necesita:

1. Una lección **proactiva**, no un Q&A que espera preguntas.
2. Contenido en **español**, en lenguaje simple, sin jerga de board gaming sin explicar.
3. Presentada **en bloques**, avanzando solo cuando el aprendiz confirma ("listo"/"siguiente"), no todo de una vez.

**Restricción de diseño clave:** este modo se usará 1-2 veces por juego (la primera vez que se enseña). El resto del uso recurrente sigue siendo `deep_dive` normal para repasar detalles de setup/turno. Por lo tanto la solución debe reutilizar al máximo la infraestructura existente y evitar estado nuevo — no se justifica construir un sistema separado para algo de uso raro.

**No-objetivos** (descartados explícitamente durante el diseño):
- Quizzes o chequeos formales de comprensión entre bloques.
- Tracking de progreso persistente en el backend (en qué bloque va cada sesión).
- Un segundo archivo de contenido (`teaching_kids.md` o similar) separado de `teaching.md`.
- Migración masiva de los `teaching.md` de los juegos ya importados.

## 2. Arquitectura y flujo de datos

Todo el trabajo nuevo entra en el mismo pipeline de tres piezas que ya existe para `deep_dive`:

```
scripts/compiler/llm_compiler.py   (genera teaching.md, una vez, al importar)
        → mybgg-wiki (games/<slug>/teaching.md, en git)
        → sync-to-kv.yml → Cloudflare KV (WIKI namespace)
        → worker/src/index.js (handleChat, mode='teach') lee KV, arma contexto
        → chat.html (botón nuevo, mismo mecanismo de streaming SSE)
```

No hay piezas nuevas en el flujo, solo una rama de comportamiento nueva en tres archivos existentes: `llm_compiler.py`, `worker/src/index.js`, `chat.html`.

## 3. Cambios en `mybgg-wiki`: contenido de `teaching.md`

### `scripts/compiler/llm_compiler.py` → prompt de `"teaching"`

Hoy (línea 82-91) genera notas en inglés para quien va a enseñar en persona:

```python
"teaching": (
    f"{ex}Write a Markdown teaching guide for explaining \"{name}\" to new players.\n{rb}\n"
    "Include these sections:\n"
    "1. **5-minute explanation** — shortest useful introduction\n"
    "2. **Suggested teaching order** — what to explain first, second, third\n"
    "3. **First-round walkthrough** — narrate a typical first round\n"
    "4. **Rules to postpone** — what to defer until it comes up naturally\n"
    "5. **Common mistakes** — what new players get wrong most often\n"
    "6. **Frequently forgotten rules** — even experienced players miss these"
),
```

Se reescribe para producir el mismo esqueleto de 6 secciones (porque ya mapea bien al flujo de bloques que necesita el modo `teach`, ver §4) pero dirigido directamente al aprendiz, en español, sin jerga sin explicar:

```python
"teaching": (
    f"{ex}Write a teaching guide for \"{name}\", entirely in Spanish, addressed directly "
    "to a beginner learning the game for the first time (a child or an adult with no "
    "board-gaming experience) — as if you were sitting next to them explaining it. "
    "Use simple, warm, second-person language ('vos vas a...', 'ahora te toca...'). "
    "Never use board-gaming jargon (worker placement, engine building, etc.) without "
    "explaining it in plain words the first time it appears. Keep sentences short.\n"
    f"{rb}\n"
    "Include these sections, in this order:\n"
    "1. **Explicación de 5 minutos** — de qué se trata el juego, en el lenguaje más simple posible\n"
    "2. **Orden de enseñanza** — una lista numerada de temas a explicar, uno a la vez; cada ítem "
    "debe ser un párrafo corto y autocontenido, listo para leérselo o parafraseárselo al aprendiz "
    "directamente (no una instrucción meta como 'explicar que...', sino la explicación en sí)\n"
    "3. **Primera ronda paso a paso** — narra un primer turno típico en segunda persona, como si "
    "el aprendiz lo estuviera jugando en este momento\n"
    "4. **Reglas para más adelante** — reglas menores a mencionar solo si surgen naturalmente, no "
    "de entrada (esto es para que quien lidera la partida sepa qué callarse al principio)\n"
    "5. **Errores comunes de principiante** — en lenguaje simple, qué suelen hacer mal\n"
    "6. **Detalles que se olvidan** — reglas que hasta jugadores con experiencia pasan por alto"
),
```

`SYSTEM` (constante global, línea 5-10) sigue diciendo "Write in English" para el resto de secciones (`index`, `setup`, `rules`, `faq`, `glossary`) — **no se toca**, porque siguen siendo referencia técnica donde la terminología en inglés es preferible. Solo el prompt de `teaching` fuerza español explícitamente, sobreescribiendo esa instrucción global para esa sección puntual.

### Migración de contenido existente

Sin proyecto de migración masiva. Los ~100 juegos ya importados conservan su `teaching.md` viejo (inglés, notas de instructor) hasta que se reimporten. El modo `teach` (§4) sigue funcionando con el contenido viejo — el system prompt ya le pide al LLM presentarlo en bloques y en español, así que igual traduce/adapta el tono al vuelo para esos juegos, solo que con menor calidad que el contenido regenerado. Se regenera puntualmente (`add_game.py --bgg_id <id> ...` sobre un juego ya existente) para los 2-3 juegos que se vayan a enseñar pronto.

## 4. Cambios en `mybgg` (Worker): nuevo modo `teach`

### `worker/src/index.js` → `SYSTEM_PROMPTS`

Nueva entrada junto a `discovery` y `deep_dive` (misma forma: función que recibe `gameName`):

```javascript
teach: {
  es: (gameName) =>
    `Eres un tutor paciente enseñándole ${gameName} a alguien que nunca lo ha jugado — puede ser un niño o un adulto sin experiencia en juegos de mesa. Tienes acceso a la guía de enseñanza del juego (ya escrita en español, en bloques, para principiantes) junto con reglas, FAQ y glosario como referencia si el aprendiz pregunta algo puntual.
Guía la lección de forma PROACTIVA, no esperes a que pregunten:
1. Empieza con la "Explicación de 5 minutos" como bienvenida.
2. Luego recorré el "Orden de enseñanza" un ítem a la vez. Después de cada ítem, preguntá si está listo/a para seguir o si tiene dudas — no avances al siguiente ítem hasta que el aprendiz lo confirme (por ejemplo "listo", "dale", "sí", o similar).
3. Cuando termines el orden de enseñanza, contá la "Primera ronda paso a paso" como si estuviera pasando ahora mismo.
4. Cerrá con los "Errores comunes de principiante" antes de que empiecen a jugar de verdad.
5. Las "Reglas para más adelante" NO las menciones de entrada — solo si el aprendiz pregunta algo directamente relacionado.
Si en cualquier momento te preguntan algo fuera de la secuencia, respondé la duda puntual (usando reglas/FAQ/glosario si hace falta) y después retomá donde ibas.
Usá lenguaje simple y cálido, en segunda persona, sin jerga de juegos de mesa sin explicarla la primera vez.
IMPORTANTE: Solo respondé sobre ${gameName} y juegos de mesa en general. Si preguntan otra cosa, redirigí amablemente la conversación.`,
  en: (gameName) =>
    `You are a patient tutor teaching ${gameName} to someone who has never played it — a child or an adult with no board-gaming experience. You have access to the game's teaching guide (already written for beginners) plus rules, FAQ, and glossary as reference if the learner asks something specific.
Guide the lesson PROACTIVELY, don't wait to be asked:
1. Start with the "5-minute explanation" as a welcome.
2. Walk through the "teaching order" one item at a time. After each item, ask if they're ready to move on or have questions — don't advance until the learner confirms (e.g. "ready", "yes", "go on").
3. Once you finish the teaching order, narrate the "first round walkthrough" as if it's happening right now.
4. Close with "common beginner mistakes" before they start playing for real.
5. Don't bring up "rules for later" unprompted — only if the learner asks something directly related.
If asked something out of sequence at any point, answer it (using rules/FAQ/glossary if needed) and then resume where you left off.
Use simple, warm, second-person language, without unexplained board-gaming jargon.
IMPORTANT: Only answer about ${gameName} and board games in general. If asked about anything else, kindly redirect the conversation.`,
},
```

### `worker/src/index.js` → `handleChat()`

Rama nueva junto a la de `deep_dive` (hoy en línea 518-554), reutilizando el mismo fetch de secciones y `buildDeepDiveContext` — solo cambia qué `promptFn` se pasa:

```javascript
} else if ((mode === 'deep_dive' || mode === 'teach') && game) {
  if (!/^[a-z0-9-]+$/.test(game)) {
    return sseError(request, 'Invalid game slug.');
  }
  if (!Array.isArray(expansions) || expansions.length > 10) {
    return sseError(request, 'Invalid expansions list.');
  }
  if (!expansions.every((slug) => /^[a-z0-9-]+$/.test(slug))) {
    return sseError(request, 'Invalid expansion slug.');
  }

  const sectionNames = ['index', 'rules', 'teaching', 'faq', 'glossary'];
  const slugs = [game, ...expansions];
  const fetched = await Promise.all(
    slugs.flatMap((slug) =>
      sectionNames.map((section) => env.WIKI.get(`games/${slug}/${section}`))
    )
  );
  const entries = slugs.map((slug, i) => {
    const offset = i * sectionNames.length;
    return {
      slug,
      index: fetched[offset],
      rules: fetched[offset + 1],
      teaching: fetched[offset + 2],
      faq: fetched[offset + 3],
      glossary: fetched[offset + 4],
    };
  });

  const promptFn = SYSTEM_PROMPTS[mode][language] ?? SYSTEM_PROMPTS[mode].es;
  systemContent = buildDeepDiveContext({
    base: entries[0],
    expansions: entries.slice(1),
    promptFn,
  });
} else {
  return sseError(request, 'Invalid mode. Use "discovery", "deep_dive", or "teach" with a game slug.');
}
```

`buildDeepDiveContext` (`worker/src/deepDiveContext.js`) **no se toca** — ya arma el mismo contexto (`index`, `rules`, `teaching`, `faq`, `glossary`) sin importar qué modo lo llame; el nombre de la función queda desalineado semánticamente (arma contexto para `teach` también) pero renombrarla es un cambio cosmético que no aporta al objetivo — se deja así.

Sin tracking de estado nuevo: el progreso de la lección (qué bloque ya se cubrió) se infiere del `history` que ya viaja completo en cada request, igual que hoy en `deep_dive`. El LLM ve en el historial qué bloques ya narró y continúa desde ahí.

## 5. Cambios en `chat.html`: botón nuevo

Junto al botón `btn-start-deepdive` ("Empezar"), un botón nuevo `btn-start-teach` ("Enséñame a jugar"), visible en los mismos momentos que `btn-start-deepdive` (cuando hay un juego seleccionado en `game-select`).

Nueva función, calco de `startDeepDive` (línea 463-479) pero con `mode = 'teach'` y mensaje de apertura de tutor en vez de "listo para tus preguntas":

```javascript
function startTeach(baseSlug, baseLabel, expansionSlugs, expansionLabels) {
  currentMode = 'teach';
  currentGame = baseSlug;
  currentExpansions = expansionSlugs;
  currentGameName = [baseLabel, ...expansionLabels].join(' + ');
  history = [];
  setAwaitingCombo(false);

  const safeName = currentGameName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  document.getElementById('mode-bar').textContent = `Modo: Aprendiendo ${currentGameName}`;
  document.getElementById('btn-reset-discovery').style.display = 'inline';
  document.getElementById('chat-container').innerHTML = '';

  sendMessage(currentLanguage === 'en'
    ? `Teach me how to play ${safeName} from scratch.`
    : `Enséñame a jugar ${safeName} desde cero.`);
}
```

A diferencia de `startDeepDive` (que agrega un mensaje de apertura local con `addMessage` sin llamar al worker), `startTeach` dispara un `sendMessage` real — así el primer turno ya lo genera el LLM siguiendo el system prompt de `teach` (bienvenida + explicación de 5 min), en vez de un mensaje estático hardcodeado en el frontend.

El resto del flujo (envío de `mode: currentMode` en cada request, streaming SSE, `resetToDiscovery()`) no cambia — ya es genérico respecto al valor de `currentMode`.

## 6. Edge cases

- **`teaching.md` no existe todavía para un juego** (falla en la generación durante import): `env.WIKI.get('games/<slug>/teaching')` devuelve `null`; `buildDeepDiveContext` ya filtra secciones vacías (`filter(Boolean)`), así que el contexto queda sin bloque de enseñanza. El system prompt de `teach` asume que existe — si falta, el LLM no tiene la guía y probablemente decline o improvise de `rules`. No se agrega manejo especial: es el mismo comportamiento que ya tiene `deep_dive` cuando falta una sección.
- **Juego con `teaching.md` viejo (formato instructor, inglés)**: el modo `teach` igual funciona — el LLM traduce/adapta el tono al vuelo a partir del prompt, con menor calidad que el contenido regenerado (ver §3, migración diferida).
- **Aprendiz se sale del guion** (pregunta algo no relacionado con el bloque actual): cubierto explícitamente en el system prompt ("respondé la duda puntual... y después retomá donde ibas").
- **Expansiones seleccionadas en modo `teach`**: mismo comportamiento que `deep_dive` — se agregan como bloques `### Expansion: <nombre>` adicionales en el contexto (vía `buildDeepDiveContext`). El prompt de `teach` no tiene instrucciones específicas para expansiones; queda a criterio del LLM incorporarlas a la secuencia. Aceptable porque enseñar con expansión de entrada es un caso raro (normalmente se enseña primero el juego base).

## 7. Testing / verificación

- `worker/test/`: agregar un test análogo a los existentes en `deepDiveContext.test.js` que confirme que `mode: 'teach'` arma el mismo tipo de contexto que `deep_dive` (mismas secciones fetcheadas) pero selecciona `SYSTEM_PROMPTS.teach` en vez de `SYSTEM_PROMPTS.deep_dive`.
- Test manual de humo en `mybgg-wiki`: regenerar `teaching.md` de un juego con el prompt nuevo (`add_game.py --bgg_id <id> ...` sobre un juego existente) y revisar a ojo que quedó en español, en bloques, sin jerga sin explicar, antes de aplicarlo a los juegos que se vayan a enseñar pronto.
- End-to-end manual: en `chat.html` local, seleccionar un juego, click en "Enséñame a jugar", confirmar que el primer mensaje es la bienvenida + explicación de 5 min (no un Q&A pasivo), y que al responder "listo" el bot avanza al siguiente ítem del orden de enseñanza en vez de repetir o saltarse pasos.

## 8. Fuera de alcance

- Quizzes o chequeos de comprensión entre bloques — descartado, se prefirió simplicidad (avanzar solo con confirmación del usuario, sin evaluar respuestas).
- Tracking de progreso persistente (en qué bloque quedó cada sesión) — no hace falta, el historial de la conversación ya lo resuelve.
- Archivo de contenido separado para el modo guiado (`teaching_kids.md`) — descartado para evitar dos fuentes de contenido a mantener sincronizadas; `teaching.md` sirve para ambos casos de uso.
- Migración masiva de `teaching.md` de juegos ya importados — se regenera bajo demanda, juego por juego, según se vaya a enseñar.
- Renombrar `buildDeepDiveContext` a algo más genérico — cambio cosmético sin impacto funcional, no vale la pena en este alcance.
