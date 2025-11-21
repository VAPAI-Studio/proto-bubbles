import GUI from 'lil-gui';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// --- Configuration ---
const CONFIG = {
    bubbleCount: 400,
    bubbleSpeed: 2.5,
    bubbleSize: 0.6,
    interactionRadius: 4.0,
    cokeRed: 0xF40009,
    bubbleColor: 0xffffff,
    bloomStrength: 0.5,
    bloomRadius: 0.4,
    bloomThreshold: 0.85,
    spawnOnBody: true,
    invertMask: false,
    bubbleLifespan: 8.0  // seconds, 0 = infinite
};

// --- Globals ---
let scene, camera, renderer, composer;
let bubbles = [];
let bodyPose, bodySegmentation, depthEstimation;
let poses = [];
let segmentationResult;
let depthResult;
let video;
let visibleWidth, visibleHeight;
let bloomPass;
let gui;
let skeletonGroup;
let segmentationDebugCanvas;
let depthDebugCanvas;

// --- Initialization ---
async function init() {
    const app = document.getElementById('app');

    scene = new THREE.Scene();
    scene.background = new THREE.Color(CONFIG.cokeRed);
    scene.fog = new THREE.FogExp2(CONFIG.cokeRed, 0.015);

    const aspect = window.innerWidth / window.innerHeight;
    camera = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000);
    camera.position.z = 20;

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    app.appendChild(renderer.domElement);

    const renderScene = new RenderPass(scene, camera);

    bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
    bloomPass.threshold = CONFIG.bloomThreshold;
    bloomPass.strength = CONFIG.bloomStrength;
    bloomPass.radius = CONFIG.bloomRadius;

    composer = new EffectComposer(renderer);
    composer.addPass(renderScene);
    composer.addPass(bloomPass);

    updateVisibleBounds();

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(10, 20, 10);
    scene.add(dirLight);

    const spotLight = new THREE.SpotLight(0xffffff, 20);
    spotLight.position.set(0, 20, 0);
    spotLight.angle = Math.PI / 4;
    spotLight.penumbra = 0.1;
    scene.add(spotLight);

    // Skeleton Group
    skeletonGroup = new THREE.Group();
    scene.add(skeletonGroup);
    skeletonGroup.visible = false;

    // Segmentation Debug Canvas
    segmentationDebugCanvas = document.createElement('canvas');
    segmentationDebugCanvas.id = 'segmentation-debug';
    segmentationDebugCanvas.style.position = 'absolute';
    segmentationDebugCanvas.style.top = '0';
    segmentationDebugCanvas.style.left = '0';
    segmentationDebugCanvas.style.width = '100%';
    segmentationDebugCanvas.style.height = '100%';
    segmentationDebugCanvas.style.pointerEvents = 'none'; // Click-through
    segmentationDebugCanvas.style.opacity = '0.4'; // Semi-transparent
    segmentationDebugCanvas.style.display = 'none'; // Hidden by default
    segmentationDebugCanvas.style.zIndex = '1000';
    document.body.appendChild(segmentationDebugCanvas);

    // Depth Debug Canvas
    depthDebugCanvas = document.createElement('canvas');
    depthDebugCanvas.id = 'depth-debug';
    depthDebugCanvas.style.position = 'absolute';
    depthDebugCanvas.style.top = '0';
    depthDebugCanvas.style.left = '0';
    depthDebugCanvas.style.width = '100%';
    depthDebugCanvas.style.height = '100%';
    depthDebugCanvas.style.pointerEvents = 'none';
    depthDebugCanvas.style.opacity = '0.6';
    depthDebugCanvas.style.display = 'none';
    depthDebugCanvas.style.zIndex = '999';
    document.body.appendChild(depthDebugCanvas);

    createBubbles();

    await setupML5();

    setupGUI();

    window.addEventListener('resize', onWindowResize, false);

    animate();
}

function setupGUI() {
    gui = new GUI({ title: 'Coke Bubbles Settings' });

    const bubbleFolder = gui.addFolder('Bubbles');
    bubbleFolder.add(CONFIG, 'bubbleCount', 50, 1000, 10).name('Count').onFinishChange(createBubbles);
    bubbleFolder.add(CONFIG, 'bubbleSpeed', 0.0, 10.0).name('Speed');
    bubbleFolder.add(CONFIG, 'bubbleSize', 0.1, 2.0).name('Size').onChange(createBubbles);
    bubbleFolder.add(CONFIG, 'bubbleLifespan', 0.0, 20.0).name('Lifespan (0=∞)');
    bubbleFolder.add(CONFIG, 'interactionRadius', 1.0, 10.0).name('Interact Radius');

    const spawnFolder = gui.addFolder('Spawning');
    spawnFolder.add(CONFIG, 'spawnOnBody').name('Spawn on Body');
    spawnFolder.add(CONFIG, 'invertMask').name('Invert Mask');

    const visualFolder = gui.addFolder('Visuals');
    visualFolder.addColor(CONFIG, 'cokeRed').name('Bg Color').onChange(c => {
        scene.background.set(c);
        scene.fog.color.set(c);
    });
    visualFolder.addColor(CONFIG, 'bubbleColor').name('Bubble Color').onChange(createBubbles);

    const bloomFolder = gui.addFolder('Bloom');
    bloomFolder.add(CONFIG, 'bloomStrength', 0.0, 3.0).name('Strength').onChange(v => bloomPass.strength = v);
    bloomFolder.add(CONFIG, 'bloomRadius', 0.0, 1.0).name('Radius').onChange(v => bloomPass.radius = v);
    bloomFolder.add(CONFIG, 'bloomThreshold', 0.0, 1.0).name('Threshold').onChange(v => bloomPass.threshold = v);

    const debugFolder = gui.addFolder('Debug');
    const debugObj = { showOverlay: true, showSkeleton: false, showSegmentation: false, showDepth: false };
    debugFolder.add(debugObj, 'showOverlay').name('Show Logs').onChange(v => {
        if (debugOverlay) debugOverlay.style.display = v ? 'block' : 'none';
    });
    debugFolder.add(debugObj, 'showSkeleton').name('Show Skeleton').onChange(v => {
        skeletonGroup.visible = v;
    });
    debugFolder.add(debugObj, 'showSegmentation').name('Show Segmentation').onChange(v => {
        if (segmentationDebugCanvas) {
            segmentationDebugCanvas.style.display = v ? 'block' : 'none';
        }
    });
    debugFolder.add(debugObj, 'showDepth').name('Show Depth').onChange(v => {
        if (depthDebugCanvas) {
            depthDebugCanvas.style.display = v ? 'block' : 'none';
        }
    });
}

function createBubbles() {
    bubbles.forEach(b => scene.remove(b));
    bubbles = [];

    const geometry = new THREE.SphereGeometry(1, 32, 32);
    const material = new THREE.MeshPhysicalMaterial({
        color: CONFIG.bubbleColor,
        transparent: true,
        opacity: 0.5,
        roughness: 0.05,
        metalness: 0.1,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05,
        transmission: 0.9,
        ior: 1.33,
        thickness: 1.0,
    });

    for (let i = 0; i < CONFIG.bubbleCount; i++) {
        // Clone material for each bubble so they can fade independently
        const bubbleMaterial = material.clone();
        const mesh = new THREE.Mesh(geometry, bubbleMaterial);

        mesh.position.x = (Math.random() - 0.5) * visibleWidth * 1.5;
        mesh.position.y = (Math.random() - 0.5) * visibleHeight * 1.5;
        mesh.position.z = (Math.random() - 0.5) * 15;

        const scale = Math.random() * CONFIG.bubbleSize + 0.1;
        mesh.scale.set(scale, scale, scale);

        const baseTime = Date.now() / 1000;
        const maxOffset = Math.max(CONFIG.bubbleLifespan, 5);
        const indexOffset = (i / CONFIG.bubbleCount) * maxOffset;  // Spread evenly across full range
        const birthRandomOffset = Math.random() * (maxOffset / CONFIG.bubbleCount);  // Add some randomness to each slot

        mesh.userData = {
            velocityMultiplier: Math.random() * 0.1,  // Store multiplier, not actual velocity
            initialScale: scale,
            wobbleSpeed: Math.random() * 3,
            wobbleOffset: Math.random() * Math.PI * 2,
            randomOffset: Math.random() * 100,
            birthTime: baseTime - indexOffset - birthRandomOffset,  // Stagger across full lifespan
            lifespanMultiplier: 0.5 + Math.random() * 1.0,  // Random 0.5-1.5x multiplier for more variation
            depth: 0.5  // Default mid-depth, will be updated on spawn
        };

        scene.add(mesh);
        bubbles.push(mesh);

        // Use proper spawn logic to position bubble initially
        if (CONFIG.spawnOnBody && segmentationResult && segmentationResult.mask) {
            respawnBubble(mesh);
        }
    }
}

// --- Debug ---
const debugOverlay = document.getElementById('debug-overlay');
function log(msg) {
    console.log(msg);
    if (debugOverlay) {
        debugOverlay.innerHTML += `<div>${msg}</div>`;
    }
}

async function setupML5() {
    log('Setting up ML5...');

    video = document.createElement('video');
    video.style.display = 'none';
    video.width = 640;
    video.height = 480;
    video.setAttribute('playsinline', '');
    document.body.appendChild(video);

    try {
        log('Requesting webcam access...');
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
        video.srcObject = stream;

        await new Promise((resolve) => {
            video.onloadedmetadata = () => {
                log(`Video metadata: ${video.videoWidth}x${video.videoHeight}`);
                video.play();
            };
            video.onplaying = () => {
                log('Video is playing!');
                resolve();
            };
        });

    } catch (err) {
        console.error('Error accessing webcam:', err);
        log(`Error: ${err.message}`);
        alert('Webcam access denied or not available. Bubbles will still float!');
        return;
    }

    // Initialize BodyPose
    log('Loading ML5 BodyPose...');
    if (typeof ml5 === 'undefined') {
        log('Error: ml5 is not defined.');
        return;
    }

    const options = {
        modelType: "MULTIPOSE_LIGHTNING",
        enableSmoothing: true,
    };

    try {
        bodyPose = ml5.bodyPose(video, options, modelLoaded);
    } catch (e) {
        log(`Error initializing bodyPose: ${e.message}`);
    }

    // Initialize BodySegmentation
    log('Loading BodySegmentation...');
    try {
        bodySegmentation = ml5.bodySegmentation(video, { maskType: "person" }, segmentationLoaded);
    } catch (e) {
        log(`Error init segmentation: ${e.message}`);
    }

    // Initialize Depth Estimation
    log('Loading Depth Estimation...');
    try {
        depthEstimation = ml5.depthEstimation(video, { filterType: 'person' }, depthLoaded);
    } catch (e) {
        log(`Error init depth estimation: ${e.message}`);
    }
}

function modelLoaded(model) {
    log('BodyPose Loaded!');
    if (model) bodyPose = model;
    if (typeof bodyPose.detectStart === 'function') {
        bodyPose.detectStart(video, gotPoses);
    } else if (typeof bodyPose.detect === 'function') {
        detectLoop();
    }
}

function segmentationLoaded(model) {
    log('Segmentation Loaded!');
    if (model) bodySegmentation = model;  // Update the global with the actual model
    console.log('Segmentation model:', bodySegmentation);
    console.log('Has detectStart?', typeof bodySegmentation.detectStart);
    console.log('Available methods:', Object.keys(bodySegmentation));

    if (bodySegmentation && typeof bodySegmentation.detectStart === 'function') {
        console.log('Starting segmentation detection...');
        bodySegmentation.detectStart(video, gotSegmentation);
    } else {
        console.warn('detectStart not available on bodySegmentation!');
    }
}

function depthLoaded(model) {
    log('Depth Estimation Loaded!');
    if (model) depthEstimation = model;
    console.log('Depth model:', depthEstimation);
    console.log('Has detectStart?', typeof depthEstimation.detectStart);
    console.log('Available methods:', Object.keys(depthEstimation));

    if (depthEstimation && typeof depthEstimation.detectStart === 'function') {
        console.log('Starting depth detection...');
        depthEstimation.detectStart(video, gotDepth);
    } else {
        console.warn('detectStart not available on depthEstimation!');
    }
}

function gotSegmentation(result) {
    segmentationResult = result;

    // Debug: Log segmentation data occasionally
    if (result && result.mask && Math.random() < 0.02) {
        const mask = result.mask;
        const data = mask.data;

        // Count person pixels in different ways
        let redCount = 0, greenCount = 0, blueCount = 0, alphaCount = 0, anyCount = 0;
        let samplePixels = [];

        for (let i = 0; i < data.length; i += 4) {
            if (data[i] > 127) redCount++;
            if (data[i+1] > 127) greenCount++;
            if (data[i+2] > 127) blueCount++;
            if (data[i+3] > 127) alphaCount++;
            if (data[i] > 127 || data[i+1] > 127 || data[i+2] > 127 || data[i+3] > 127) anyCount++;

            // Sample first 10 pixels
            if (i < 40) {
                samplePixels.push({r: data[i], g: data[i+1], b: data[i+2], a: data[i+3]});
            }
        }
        const totalPixels = (mask.width * mask.height);

        console.log('🎭 Segmentation Update:', {
            maskSize: `${mask.width}x${mask.height}`,
            redChannel: redCount,
            greenChannel: greenCount,
            blueChannel: blueCount,
            alphaChannel: alphaCount,
            anyChannel: anyCount,
            totalPixels: totalPixels,
            samplePixels: samplePixels,
            hasData: !!data
        });
    }

    if (segmentationDebugCanvas && segmentationDebugCanvas.style.display !== 'none' && result && result.mask) {
        const ctx = segmentationDebugCanvas.getContext('2d');

        // Set canvas size to match video
        if (segmentationDebugCanvas.width !== video.videoWidth) {
            segmentationDebugCanvas.width = video.videoWidth;
            segmentationDebugCanvas.height = video.videoHeight;
            console.log('Canvas resized to:', video.videoWidth, 'x', video.videoHeight);
        }

        // Clear the canvas first
        ctx.clearRect(0, 0, segmentationDebugCanvas.width, segmentationDebugCanvas.height);

        // Create a temporary canvas to hold the mask
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = video.videoWidth;
        tempCanvas.height = video.videoHeight;
        const tempCtx = tempCanvas.getContext('2d');

        // Draw the mask to temp canvas
        if (result.mask instanceof ImageData) {
            tempCtx.putImageData(result.mask, 0, 0);
        } else if (result.mask.data) {
            const imageData = new ImageData(
                new Uint8ClampedArray(result.mask.data),
                result.mask.width,
                result.mask.height
            );
            tempCtx.putImageData(imageData, 0, 0);
        }

        // Now draw the temp canvas to the main canvas with mirroring
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(tempCanvas, -segmentationDebugCanvas.width, 0);
        ctx.restore();
    }
}

function gotDepth(result) {
    depthResult = result;

    // Debug: Log depth data structure occasionally
    if (result && Math.random() < 0.05) {
        console.log('📏 Depth Result:', {
            hasDepth: !!result.depth,
            depthType: result.depth ? typeof result.depth : 'none',
            isImageData: result.depth instanceof ImageData,
            keys: result.depth ? Object.keys(result.depth) : [],
            width: result.depth?.width,
            height: result.depth?.height,
            hasData: !!(result.depth?.data)
        });
    }

    // Debug: Visualize depth map
    if (depthDebugCanvas && depthDebugCanvas.style.display !== 'none' && result && result.depth) {
        const ctx = depthDebugCanvas.getContext('2d');

        // Set canvas size to match video
        if (depthDebugCanvas.width !== video.videoWidth) {
            depthDebugCanvas.width = video.videoWidth;
            depthDebugCanvas.height = video.videoHeight;
            console.log('Depth canvas resized to:', video.videoWidth, 'x', video.videoHeight);
        }

        // Clear canvas first
        ctx.clearRect(0, 0, depthDebugCanvas.width, depthDebugCanvas.height);

        // Create temp canvas for the depth image
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = video.videoWidth;
        tempCanvas.height = video.videoHeight;
        const tempCtx = tempCanvas.getContext('2d');

        // Draw depth image (ML5 provides it in different formats)
        if (result.depth instanceof ImageData) {
            tempCtx.putImageData(result.depth, 0, 0);
        } else if (result.depth.data) {
            // Create ImageData from raw data
            const imageData = new ImageData(
                new Uint8ClampedArray(result.depth.data),
                result.depth.width,
                result.depth.height
            );
            tempCtx.putImageData(imageData, 0, 0);
        }

        // Mirror horizontally
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(tempCanvas, -depthDebugCanvas.width, 0);
        ctx.restore();
    }
}

function detectLoop() {
    if (video && video.readyState >= 2 && bodyPose && typeof bodyPose.detect === 'function') {
        bodyPose.detect(video, (results) => {
            gotPoses(results);
            requestAnimationFrame(detectLoop);
        });
    } else {
        requestAnimationFrame(detectLoop);
    }
}

function gotPoses(results) {
    poses = results;
    if (debugOverlay && Math.random() < 0.05) {
        const lastChild = debugOverlay.lastElementChild;
        if (lastChild && lastChild.textContent.startsWith('Poses:')) {
            lastChild.textContent = `Poses: ${results.length} `;
        } else {
            debugOverlay.innerHTML += `< div > Poses: ${results.length}</div > `;
        }
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    updateVisibleBounds();
}

function updateVisibleBounds() {
    const vFOV = THREE.MathUtils.degToRad(camera.fov);
    visibleHeight = 2 * Math.tan(vFOV / 2) * camera.position.z;
    visibleWidth = visibleHeight * camera.aspect;
}

function animate() {
    requestAnimationFrame(animate);

    const time = Date.now() * 0.001;

    if (poses.length > 0) {
        updateSkeleton();
    }

    bubbles.forEach(bubble => {
        // Calculate velocity dynamically based on current speed setting
        const velocity = CONFIG.bubbleSpeed * bubble.userData.velocityMultiplier;
        bubble.position.y += velocity;

        bubble.position.x += Math.sin(time * bubble.userData.wobbleSpeed + bubble.userData.wobbleOffset) * 0.01;
        bubble.position.z += Math.cos(time * bubble.userData.wobbleSpeed + bubble.userData.randomOffset) * 0.01;

        // Apply depth-based scaling
        if (bubble.userData.depth !== undefined) {
            // Scale based on depth: closer objects (higher depth value) are larger
            // depth ranges from 0 (far) to 1 (close)
            // Scale factor: 0.5x to 2.0x based on depth
            const depthScale = 0.5 + (bubble.userData.depth * 1.5);
            const targetScale = bubble.userData.initialScale * depthScale;
            bubble.scale.setScalar(targetScale);
        }

        // Check lifespan
        if (CONFIG.bubbleLifespan > 0) {
            const actualLifespan = CONFIG.bubbleLifespan * bubble.userData.lifespanMultiplier;
            const age = time - bubble.userData.birthTime;
            if (age > actualLifespan) {
                respawnBubble(bubble);
                return;  // Skip rest of processing for this bubble
            }

            // Optional: Fade out in last 20% of life
            const lifeFraction = age / actualLifespan;
            if (lifeFraction > 0.8) {
                const fadeAmount = 1 - ((lifeFraction - 0.8) / 0.2);
                bubble.material.opacity = 0.5 * fadeAmount;
            } else {
                bubble.material.opacity = 0.5;
            }
        }

        if (bubble.position.y > visibleHeight / 2 + 5) {
            respawnBubble(bubble);
        }

        // Only interact with skeleton if not spawning on body
        if (poses.length > 0 && !CONFIG.spawnOnBody) {
            poses.forEach(pose => {
                if (pose.keypoints) {
                    // Interact with Arms and Legs (Indices 5-16)
                    pose.keypoints.forEach((keypoint, index) => {
                        if (index >= 5 && index <= 16) {
                            interactWithKeypoint(bubble, keypoint);
                        }
                    });

                    // Interact with Torso (Average of Shoulders 5,6 and Hips 11,12)
                    const s1 = pose.keypoints[5];
                    const s2 = pose.keypoints[6];
                    const h1 = pose.keypoints[11];
                    const h2 = pose.keypoints[12];

                    if (s1 && s2 && h1 && h2 && s1.confidence > 0.1 && s2.confidence > 0.1 && h1.confidence > 0.1 && h2.confidence > 0.1) {
                        const torsoX = (s1.x + s2.x + h1.x + h2.x) / 4;
                        const torsoY = (s1.y + s2.y + h1.y + h2.y) / 4;
                        interactWithKeypoint(bubble, { x: torsoX, y: torsoY, confidence: 1 });
                    }
                }
            });
        }
    });

    composer.render();
}

function updateSkeleton() {
    // Clear previous lines/points
    while (skeletonGroup.children.length > 0) {
        skeletonGroup.remove(skeletonGroup.children[0]);
    }

    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x00ff00 });
    const pointGeometry = new THREE.SphereGeometry(0.15, 8, 8); // Small spheres for points
    const pointMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 }); // Red points

    poses.forEach(pose => {
        // Draw Points
        if (pose.keypoints) {
            pose.keypoints.forEach(kp => {
                if (kp.confidence > 0.2) {
                    const vec = getVector3FromKeypoint(kp);
                    const point = new THREE.Mesh(pointGeometry, pointMaterial);
                    point.position.copy(vec);
                    skeletonGroup.add(point);
                }
            });
        }

        // Draw Lines
        const connections = [
            [5, 7], [7, 9], // Left Arm
            [6, 8], [8, 10], // Right Arm
            [5, 6], // Shoulders
            [11, 12], // Hips
            [5, 11], [6, 12], // Torso
            [11, 13], [13, 15], // Left Leg
            [12, 14], [14, 16] // Right Leg
        ];

        connections.forEach(([startIdx, endIdx]) => {
            if (pose.keypoints[startIdx] && pose.keypoints[endIdx]) {
                const start = pose.keypoints[startIdx];
                const end = pose.keypoints[endIdx];

                if (start.confidence > 0.2 && end.confidence > 0.2) {
                    const startVec = getVector3FromKeypoint(start);
                    const endVec = getVector3FromKeypoint(end);

                    const geometry = new THREE.BufferGeometry().setFromPoints([startVec, endVec]);
                    const line = new THREE.Line(geometry, lineMaterial);
                    skeletonGroup.add(line);
                }
            }
        });
    });
}

function getVector3FromKeypoint(keypoint) {
    const normX = 1 - (keypoint.x / video.videoWidth);
    const normY = 1 - (keypoint.y / video.videoHeight);
    const x = (normX - 0.5) * visibleWidth;
    const y = (normY - 0.5) * visibleHeight;
    return new THREE.Vector3(x, y, 0);
}

function respawnBubble(bubble) {
    let spawned = false;

    // Debug: Log spawn attempts occasionally
    const shouldDebug = Math.random() < 0.02;
    if (shouldDebug) {
        console.log('🔄 Respawn attempt:', {
            spawnOnBody: CONFIG.spawnOnBody,
            hasSegResult: !!segmentationResult,
            hasMask: !!(segmentationResult && segmentationResult.mask),
            maskData: segmentationResult?.mask?.data ? 'yes' : 'no'
        });
    }

    if (CONFIG.spawnOnBody && segmentationResult && segmentationResult.mask) {
        let attempts = 0;
        let personPixelCount = 0;
        let sampleValues = [];

        while (!spawned && attempts < 200) {
            const rx = Math.random();
            const ry = Math.random();

            if (segmentationResult.mask.data) {
                const w = segmentationResult.mask.width;
                const h = segmentationResult.mask.height;
                const mx = Math.floor(rx * w);
                const my = Math.floor(ry * h);
                const index = (my * w + mx) * 4;

                // Check all RGBA channels
                const r = segmentationResult.mask.data[index];
                const g = segmentationResult.mask.data[index + 1];
                const b = segmentationResult.mask.data[index + 2];
                const a = segmentationResult.mask.data[index + 3];

                // Sample some values for debugging
                if (attempts < 5) {
                    sampleValues.push({ mx, my, r, g, b, a });
                }

                // ML5 bodySegmentation uses ALPHA channel for person mask!
                const isPerson = a > 127;

                if (isPerson) personPixelCount++;

                let shouldSpawn = CONFIG.invertMask ? !isPerson : isPerson;

                if (shouldSpawn) {
                    // Convert mask coordinates to world space
                    // mx and my are already pixel coordinates in the mask
                    // Need to normalize them based on mask dimensions, then mirror and map to world
                    const normX = 1 - (mx / w);  // Mirror horizontally
                    const normY = 1 - (my / h);   // Invert vertically (mask Y goes down, world Y goes up)

                    bubble.position.x = (normX - 0.5) * visibleWidth;
                    bubble.position.y = (normY - 0.5) * visibleHeight;

                    // Sample depth at this position
                    let depthValue = 0.5; // Default mid-depth
                    if (depthResult && depthResult.depth && depthResult.depth.data) {
                        const depthData = depthResult.depth.data;
                        const depthW = depthResult.depth.width;
                        const depthH = depthResult.depth.height;

                        // Map mx, my to depth coordinates (they might be different resolutions)
                        const depthX = Math.floor((mx / w) * depthW);
                        const depthY = Math.floor((my / h) * depthH);
                        const depthIndex = (depthY * depthW + depthX) * 4;

                        // Depth is typically stored in grayscale (r=g=b), normalized 0-255
                        // Lower values = closer, higher values = farther
                        depthValue = depthData[depthIndex] / 255.0;
                    }

                    // Store depth in bubble userData (inverted: closer = higher value for larger bubbles)
                    bubble.userData.depth = 1.0 - depthValue; // Closer objects have higher depth value

                    spawned = true;

                    if (Math.random() < 0.01) { // Log 1% of spawns
                        console.log('✅ Spawned:', {
                            mx, my, normX: normX.toFixed(2), normY: normY.toFixed(2),
                            x: bubble.position.x.toFixed(1), y: bubble.position.y.toFixed(1),
                            depth: bubble.userData.depth.toFixed(2)
                        });
                    }
                }
            }
            attempts++;
        }

        // Debug when failing
        if (!spawned) {
            const coverage = (personPixelCount / 200 * 100).toFixed(1);
            console.log('❌ Spawn FAILED after 200 attempts:', {
                personPixels: personPixelCount,
                coverage: coverage + '%',
                maskSize: segmentationResult.mask.width + 'x' + segmentationResult.mask.height,
                sampleValues: sampleValues,
                invertMask: CONFIG.invertMask,
                note: 'Person pixels found but failed to spawn - check mask data'
            });
        }
    } else {
        if (Math.random() < 0.001) {  // Log occasionally, not on every bubble
            console.log('⚠️ Spawn conditions not met:', {
                spawnOnBody: CONFIG.spawnOnBody,
                hasSegResult: !!segmentationResult,
                hasMask: !!(segmentationResult && segmentationResult.mask)
            });
        }
    }

    if (!spawned) {
        // Fallback to bottom
        bubble.position.x = (Math.random() - 0.5) * visibleWidth;
        bubble.position.y = -visibleHeight / 2 - 5;
    }

    bubble.position.z = (Math.random() - 0.5) * 15;

    // Reset birth time for lifespan tracking
    bubble.userData.birthTime = Date.now() / 1000;

    // Reset lifespan multiplier for variation
    bubble.userData.lifespanMultiplier = 0.5 + Math.random() * 1.0;

    // Reset opacity
    if (bubble.material) {
        bubble.material.opacity = 0.5;
    }
}

function interactWithKeypoint(bubble, keypoint) {
    if (!keypoint || keypoint.confidence < 0.2) return;

    const normX = 1 - (keypoint.x / video.width);
    const normY = 1 - (keypoint.y / video.height);

    const targetX = (normX - 0.5) * visibleWidth;
    const targetY = (normY - 0.5) * visibleHeight;

    const dx = bubble.position.x - targetX;
    const dy = bubble.position.y - targetY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < CONFIG.interactionRadius) {
        const force = (CONFIG.interactionRadius - dist) / CONFIG.interactionRadius;
        const angle = Math.atan2(dy, dx);

        bubble.position.x += Math.cos(angle) * force * 0.8;
        bubble.position.y += Math.sin(angle) * force * 0.8;

        bubble.scale.setScalar(bubble.userData.initialScale * (1 + force * 0.5));
    } else {
        bubble.scale.lerp(new THREE.Vector3(bubble.userData.initialScale, bubble.userData.initialScale, bubble.userData.initialScale), 0.1);
    }
}

init();
