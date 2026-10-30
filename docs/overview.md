# Project overview

A frontend for Pi agent harness that allows managing multiple chats and projects with artefacts.

## Main features

- chatting with Pi via the UI
- creating and managing projects
- chatting with Pi in a context of a project, with project details and artefacts

### Definitions

**Artefact** is a project file, uploaded or created by Pi, that should be persisted beyond the scope of a single chat in the project. User uploads directly to the project are always artefacts. Chat uploads or files created by Pi are not artefacts, unless Pi explicitly decides something should be an artefact - backend exposes a `save_artefact` tool which Pi can use. Individual chats (outside of projects) cannot have artefacts. Pi cannot change artefacts, only save new ones.

**Project** is a container for chats which has its own name, optional instructions/prompt injected to an agent, and associated artefacts.

## Roadmap

### Milestone 1

- a web UI that connects to backend that runs Pi
- chat with Pi using a specified model picked per chat
- live sync: chat keeps running in the background, client can always disconnect and reconnect to it

### Milestone 2

- show everything that is shown inside the Pi session (eg. bash output, diffs) with ability to auto collapse/expand specific type of output
- stop and steer a run
- switch models per chats
- edit messages
- retry messages
- display context info: total tokens in the context (eg. 45k/200k)
- archive chats, unarchive chats

### Milestone 3

- create and delete projects
- set project name and custom instructions
- chat within a scope of a project
- list, upload, download and delete project artefacts

### Milestone 4

- support for images (uploading and rendering)
- support for file attachments
- multi user support for chats and projects
- MacOS and Android apps
- notification (desktop, web, mobile) when chat finishes

### Non goals

- explicit branching and forking (editing a message can still branch/fork, but transparently to the user)
- slash commands
- prompt templates
- compaction controls (autocompact is fine)
- support for extension dialogs or agent modes (eg. plan)

## Details

Client-server architecture. Server is responsible for holding all data and managing Pi sessions. Clients are thin and dumb and trust the server as the source of truth. When opened for the first time clients show a prompt to enter the URL of the backend.

### Backend

- manages Pi sessions via the Pi typescript SDK
- single chat is a single Pi session, scoped to a new folder
- each Pi shares settings (eg. models.json, MCP, extensions, other stuff from ~/.pi/agent), the only isolated part is filesystem Pi has access to. No need for stronger isolation (eg. containers or sandboxing) - we rely on Pi getting clear instructions not to touch anything outside of the current folder. It's not a security boundary.
- supports streaming responses and showing thinking blocks
- chats are persisted in storage (metadata in a database, transcript in JSONL files), folders that Pi is scoped to are transient - they should be kept around but with expectation that they can be pruned at some point, so Pi should be able to handle that gracefully - eg. by reporting that files were lost. There is no automatic pruning at this stage.
  - Pi JSONL sessions are stored in a separate folder outside of ~/.pi/agent/sessions - transcripts are the only copy of a chat, so they live in the app's data folder where the Pi CLI's session picker can't rename or delete them, and where they can be grouped per user
- project artefacts are injected into each chat folder (eg. by linking?) so that multiple chats can use the same pool of artefacts
- chats are running independently of clients being connected to it

#### Authentication and multi user support

Proper login flow is a future improvement. For now the backend should scope Pi sessions, chats, artefacts etc. so that it can support multiple users, but for now it's fine to assume that whoever sends a request is authenticated and is the first/default user. Until auth exists backend accepts requests from anyone.

Pi settings, MCP settings etc. are global. Only chats, projects and artefacts are scoped per user and exposed to that user only.

### Frontend

- dedicated MacOS desktop app
- dedicated Android app
- responsive web UI that works well in both desktop and mobile browsers
- multiple clients can interact with the same chat, and all of them should update simultaneously