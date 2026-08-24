# Changelog

## Version 2.1.0 (In Development - October 2025)
- Added Grafana/Prometheus monitoring stack for performance metrics and latency tracking
- Added multicast management functionality
- Enhanced Matrox Convert IP integration:
  - Multiviewer control support
  - PTP (Precision Time Protocol) management
  - Device restart controls
  - Environment variable support for credentials (MATROX_CIP_USER, MATROX_CIP_PASSWORD)
  - Authentication helper for automated device login
- Added M4350 network switch connector with LLDP discovery and topology support
- Added ZeroTier VPN integration with auto-authorization
- Enhanced Q-SYS integration with improved crosspoint control and multiviewer functions
- Improved NMOS device grouping to prevent duplicate device entries
- Added performance optimizations:
  - O(1) device/flow lookups (crosspointOptimizedLookup)
  - Predictive connection staging
  - Enhanced staging algorithms
  - Connection latency measurement
- Fixed authentication issues (requires manual fix in config/users.json)
- Added automatic reconnection when flow settings change (SDP file changes)
- Updated logic for crosspoint numbers with UI for management
- Added UI for multicast address configuration
- Fixed detection for newer Matrox Convert IP models
- Comprehensive documentation updates (WebSocket API, Q-SYS integration, device guides)

## Version 2.0.0 (September 27, 2024)
- Complete redesign of the server core for supporting more features
- Multithreaded server architecture
- Complete redesign of the UI (switched from Angular to Svelte for improved performance)
- Added basics for implementation of device abstractions
- Bug fixing and stability improvements