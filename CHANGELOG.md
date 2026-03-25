# Changelog

All notable changes to **OpenCowork** will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com).

## [0.7.0] - 2026-03-25

### Refactored

- **chat**: Remove virtual scroll from MessageList component, simplify static list rendering and remove `@tanstack/react-virtual` dependency
- **ui**: Replace store method calls with direct state access for channel, MCP, and auto-model selection states
- **cowork**: Optimize ContextPanel provider state access with shallow comparison to reduce unnecessary re-renders

### Changed

- Updated tsconfig.web.tsbuildinfo build artifacts
- Fixed line ending formatting warnings across multiple component files

## [0.6.6] - 2026-03-25

### Added

- Added SSH configuration import support for both OpenCoWork exports and OpenSSH config files, including conflict preview, selective import actions, and automatic connection list refresh.
- Added an application-level auto-update toggle in Settings so automatic update checks can be enabled or disabled persistently.

### Changed

- Improved project memory resolution to prefer workspace-local `.agents` files with fallback to legacy root memory files, and applied project `AGENTS.md` content to prompt recommendations for local sessions.
- Simplified skills market access by allowing users to browse and test marketplace availability without requiring an API key upfront.
- Refined chat and workspace UI behavior across project home/archive pages, sidebar layout, selected-file handling, and session presentation.
- Updated the documentation homepage release badge from `v0.6.5` to `v0.6.6`.

### Fixed

- Kept the chat composer state in sync more reliably after document updates and initialization.
- Cleaned up pending session state more thoroughly when deleting sessions or projects.
- Closed the draw page when entering sessions, opened markdown preview links externally, and preserved terminal/tool state consistency after aborted runs.

## [0.6.5] - 2026-03-24

### Added

- Added project workspace navigation with dedicated project home/archive pages, a workspace sidebar, and project-bound channel settings.
- Added a built-in `/plan` command for entering Plan Mode directly from chat.
- Added personal Weixin media support for sending images/files and downloading inbound image messages for multimodal processing.
- Added an open source agent SDK survey covering Python, TypeScript, C#, and Java options.

### Changed

- Improved the chat composer and message actions with file-aware drafting, queued draft editing, and attachment-aware layout behavior.
- Expanded the onboarding tour with dedicated Clarify, Cowork, and Code mode guidance plus updated English and Chinese copy.
- Updated the docs Docker build and CI workflow to use safer memory settings and Node.js 22.

### Fixed

- Flushed completed tool events before ending aborted agent runs so terminal tool states stay consistent.
- Fixed the home composer sizing when attachments are present.
- Hardened the macOS unsigned build and release signing flow with stronger validation, ad-hoc signing support, and library validation adjustments.

### Refactored

- Simplified the channel settings panel layout by removing redundant project-name prop threading.
- Removed redundant hover tooltip content from the right panel rail tabs.