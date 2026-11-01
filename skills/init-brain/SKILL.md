---
name: init-brain
description: 'Arranca canonical-wiki en la máquina de la persona: entrevista, vault, skills, .env, Postgres y un primer ingest del demo. Usar cuando pidan "/init-brain", "inicializa el cerebro", "monta el vault" o "bootstrap".'
---

# /init-brain

No hay wizard de Node. Esta skill es la entrevista. Una pregunta cada vez. No lances `sync:wiki` sin un sí explícito.

## 0. Requisitos

Para y explica qué falta si `node -v` no es 24 o superior, si `docker compose version` falla, o si el puerto 5432 está ocupado por otra base. `pdftoppm` y `claude` son opcionales: el primero solo para `ingest:bills`, el segundo para `monthly` y `prep:121`.

## 1. Entrevista

1. Ruta del vault: uno nuevo o uno de Obsidian que ya exista.
2. Idioma de las notas. Avisa de que el pipeline está pensado para español: los encabezados `## Trabajo`, `## Notas rápidas`, `## Páginas hijas` y `## Archivo` son contrato.
3. De tres a ocho dominios, con una línea de qué acumular en cada uno.
4. Carpetas humanas: las de `vault-template/` o las que ya tenga.
5. Si usa notas diarias y 1:1.
6. Qué módulos enciende: `ynab`, `withings`, `bills`, `job`. El default es solo `brain`.
7. Proveedor de síntesis: OpenAI o DeepSeek.

## 2. Vault

- Vault nuevo: copia `vault-template/` a la ruta elegida.
- Vault existente: crea solo `📒 Wiki/` y las plantillas que falten. No toques ninguna nota.
- Rellena `## Priority domains` en `CLAUDE.md`. No cambies el resto del esquema.
- Si ya hay un `CLAUDE.md`, enseña el diff y espera un sí. No lo sobrescribas antes.

## 3. Skills

Copia las skills elegidas a `<vault>/.cursor/skills/`. Si la persona usa Claude Code y pide explícitamente la copia global, `<vault>` sigue siendo el destino por defecto: no copies a `~/.claude/skills/` salvo que lo pida en esta frase.

Si una skill con el mismo nombre ya existe, no la pises. Enseña el diff y deja elegir: conservar, instalar con otro nombre, o reemplazar.

Sustituye `<BUDGET_ID>` y el resto de marcadores con valores que salgan de las tools de la persona. No los inventes.

## 4. `.env`

Généralo desde `.env.example`.

- `BRIDGE_API_KEY` y, si hay OAuth, `OAUTH_CLIENT_SECRET`: `openssl rand -base64 32` (44 caracteres).
- `DATABASE_URL` del compose: `postgresql://brain:brain@127.0.0.1:5432/brain`.
- `ENABLED_MODULES` y `OBSIDIAN_VAULT_PATH` según la entrevista.
- `BRIDGE_URL` solo `http://127.0.0.1:3000` o `http://localhost:3000`.

Las claves de proveedor las pega la persona. No las leas en voz alta ni las copies fuera de `.env`.

## 5. Arranque

`docker compose up -d`, espera el healthcheck, `npm install`, `npm start` en segundo plano. Comprueba `GET /health` y un `initialize` en `POST /brain`.

## 6. Primer ingest

Ingesta una **copia** de `examples/demo-vault`, nunca la carpeta commiteada. Después, si la persona ya tiene wiki, ingesta esa wiki. Sin `OPENAI_API_KEY`, para aquí: el vault ya se puede abrir en Obsidian y el índice espera la clave. No simules embeddings.

## 7. Cierre

Un párrafo con la URL local, los módulos montados, cómo conectar el cliente MCP y el coste de `sync:wiki` antes de preguntar si se lanza.
