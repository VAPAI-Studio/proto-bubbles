# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Three.js-based interactive visualization that creates a "Coke Bubbles" effect using ML5.js for real-time body tracking and segmentation via webcam. Bubbles are rendered with bloom post-processing and can either spawn on/around detected body silhouettes or interact with skeleton keypoints.

## Key Technologies

- **Three.js**: 3D rendering with WebGL
- **ML5.js**: Machine learning library (loaded via CDN)
  - BodyPose (MULTIPOSE_LIGHTNING model) for skeleton tracking
  - BodySegmentation for person masking
- **Vite**: Development server and bundler
- **lil-gui**: Runtime GUI for parameter tweaking

## Commands

```bash
# Start development server with hot reload
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Architecture

### Main Application Flow ([main.js](main.js))

1. **init()**: Sets up Three.js scene, camera, renderer, post-processing (bloom), lights, webcam video element, ML5 models, GUI, and bubbles
2. **setupML5()**: Initializes webcam stream, loads BodyPose and BodySegmentation models
3. **animate()**: Main render loop that updates bubble positions, handles lifespan/respawning, and optionally updates skeleton visualization
4. **createBubbles()**: Generates bubble meshes with physical material properties (transmission, clearcoat, etc.)

### ML5 Integration

- **BodyPose**: Provides skeleton keypoints (17 points per person) used for bubble interaction when `spawnOnBody = false`
- **BodySegmentation**: Provides a binary mask indicating person pixels, used for spawning bubbles on body silhouette when `spawnOnBody = true`
- Both models use callback-based initialization: `modelLoaded()` and `segmentationLoaded()`
- Detection runs continuously via `detectStart()` method

### Bubble System

Each bubble is a Three.js Mesh with:
- **Position**: 3D coordinates in world space
- **userData**: Stores velocity multiplier, initial scale, wobble parameters, birth time, lifespan multiplier
- **Material**: MeshPhysicalMaterial with transmission/clearcoat for realistic glass-like appearance
- **Lifecycle**: Respawns when reaching top of screen or exceeding lifespan

### Spawning Logic ([respawnBubble()](main.js:510))

When `spawnOnBody = true`:
- Samples random points from segmentation mask (200 attempts max)
- Checks mask red channel value (>127 = person pixel)
- Spawns at valid location after converting normalized coordinates to 3D space
- Falls back to bottom spawn if no valid mask position found

When `spawnOnBody = false`:
- Bubbles spawn at bottom and interact with skeleton keypoints via physics push forces

### Coordinate System

- Video coordinates (0-640 x 0-480) are normalized and mirrored horizontally
- Converted to Three.js world space using camera's visible bounds
- See `getVector3FromKeypoint()` for transformation logic

### Configuration System

`CONFIG` object contains all tweakable parameters, exposed via lil-gui:
- Bubble properties (count, speed, size, lifespan, interaction radius)
- Spawn mode (on body vs. interact with skeleton)
- Visual settings (colors, bloom parameters)
- Debug overlays (logs, skeleton visualization, segmentation mask)

## Important Implementation Details

- **Mirroring**: Video is mirrored horizontally to match user expectations (selfie mode)
- **Lifespan staggering**: Bubbles are initialized with staggered birth times to avoid synchronized respawning
- **Fade effect**: Bubbles fade out in final 20% of lifespan when lifespan > 0
- **Debug canvas**: Segmentation mask can be visualized as overlay for troubleshooting
- **Skeleton group**: 3D visualization of body pose keypoints and connections

## Common Development Patterns

### Adding new bubble behaviors
Modify the bubble update loop in `animate()` around line 389-445

### Adjusting ML5 models
Configuration is in `setupML5()` - change model type or options around line 256-273

### Adding GUI controls
Extend `setupGUI()` - add new folders/controls that bind to CONFIG properties

### Changing coordinate transformations
Update `getVector3FromKeypoint()` or spawn coordinate logic in `respawnBubble()`

### Modifying post-processing effects
Access `composer` and add/modify passes after line 62 in `init()`
