import * as THREE from 'three';
import { World } from './World.js';
import { Aircraft } from './Aircraft.js';
import { Input } from './Input.js';
import { OrbitControls } from './lib/OrbitControls.js';
import { Adversary } from './Adversary.js';
import { VictoryScene } from './VictoryScene.js';
import { NukeExplosion } from './NukeExplosion.js';
import { GLTFLoader } from './lib/GLTFLoader.js';

class Game {
    constructor() {
        console.log("Game Constructor Started - Three.js Revision: " + THREE.REVISION);
        // alert("Game Constructor Started!"); // Debug check

        // Get the game container, or fall back to body
        this.container = document.getElementById('game-container') || document.body;
        this.clock = new THREE.Clock();
        this.viewMode = 'chase'; // 'chase', 'cockpit', 'orbit'
        this.cameraTargetIdx = 0; // Index in adversaries array
        this.cameraTargetType = 'aircraft'; // 'aircraft', 'adversary'

        // 1. Setup High-Res WebGL Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        // Log GPU Capabilities
        console.log("Renderer Capabilities:");
        console.log(" - Max Anisotropy:", this.renderer.capabilities.getMaxAnisotropy());
        console.log(" - Precision:", this.renderer.capabilities.precision);
        console.log(" - Power Preference:", "high-performance");

        // Style the canvas to be positioned absolutely within container
        this.renderer.domElement.style.position = 'absolute';
        this.renderer.domElement.style.top = '0';
        this.renderer.domElement.style.left = '0';
        this.renderer.domElement.style.zIndex = '1';

        // Insert as first child so it's behind HUD elements
        this.container.insertBefore(this.renderer.domElement, this.container.firstChild);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x87CEEB); // Sky blue
        // 2. Camera with proper Far Plane for 80k terrain
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 150000);

        // 3. Setup Orbit Controls (Disabled by default)
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.enablePan = false;

        // Enable Zoom in Orbit view
        this.controls.enableZoom = true;
        this.controls.minDistance = 5;  // Allow zooming in
        this.controls.maxDistance = 200; // Allow zooming out

        this.controls.enabled = false; // Start in Chase mode

        this.input = new Input();
        this.world = new World(this.scene);
        this.aircraft = new Aircraft(this.scene, this.input, {
            startPosition: new THREE.Vector3(-2000, 2500, 0) // Drastic shift left and down for visibility
        });
        console.log("Player Spawn Altitude set to 2500");
        this.cameraDistanceMult = 1.5; // Default 1.5 for better spawn framing

        // Atmospheric Depth: Fog pushes horizon to 100k
        this.scene.background = new THREE.Color(0x87CEEB); // Sky blue
        this.scene.fog = new THREE.Fog(0x87CEEB, 20000, 100000);

        // Load Baby Oil model at spawn point
        this.loadSpawnModel();

        // Initialize Adversaries
        this.adversaries = []; // Fixed: Restore array init
        this.giantCount = 20;
        this.adversaryCount = 50; // Reduced to 50 Regulars (Slightly denser)
        this.hostilesRemaining = this.adversaryCount; // Only smalls initially!
        this.smallHostilesKilled = 0;
        this.giantsSpawned = false;
        this.updateKillCounter();
        this.updateHUD(); // Early feedback before click

        // --- PHASE 1: Only spawn small adversaries ---
        for (let i = 0; i < this.adversaryCount; i++) {
            const startPos = this.getRandomSpawnPosition(false); // false = not airship

            const adv = new Adversary(this.scene, this.input, {
                startPosition: startPos,
                seed: Math.random(),
                isAirship: false
            });

            // Initial Orientation
            const centerTarget = new THREE.Vector3(0, 600, 0);
            adv.mesh.lookAt(centerTarget);

            this.wrapDestroyCallback(adv);
            this.adversaries.push(adv);
        }

        this.initBackgroundMusic();

        this.instructions = document.getElementById('instructions');
        const customizePanel = document.getElementById('customize-panel');

        if (this.instructions) {
            this.instructions.addEventListener('click', (e) => {
                // Don't start if the customize panel is open
                if (customizePanel && customizePanel.style.display === 'block') return;
                // Don't start if clicking the customize button itself
                if (e.target.id === 'customize-btn') return;
                this.instructions.style.display = 'none';
                this.playIntroVideo();
                e.stopPropagation(); // Prevent it bubbling and triggering document listeners
            });
        } else {
            this.playIntroVideo();
        }

        // --- CUSTOMIZE PANEL WIRING ---
        this.initCustomizePanel();

        document.addEventListener('gameover', () => {
            // DO NOT stop the game loop, we need to render the nuke!
            // this.started = false; 

            // Disable player input and physics
            if (this.aircraft) {
                this.aircraft.manualControl = false;
                this.aircraft.mesh.visible = false; // Vaporized
            }

            if (this.bgMusic) {
                this.bgMusic.pause();
                this.bgMusic.currentTime = 0;
            }

            // Hide HUD but keep canvas
            const ui = document.getElementById('ui-container');
            if (ui) ui.style.display = 'none';

            const go = document.getElementById('game-over');
            if (go) go.style.display = 'block';

            // 💥 TRIGGER DOOMSDAY 💥
            const groundZero = new THREE.Vector3(0, this.world ? this.world.getHeightAt(0, 0) : 0, 0);
            this.nuke = new NukeExplosion(this.scene, groundZero);

            // Reposition camera for cinematic view
            this.viewMode = 'chase'; // Force out of cockpit
            this.controls.enabled = false;

            // Initialize cinematic camera orbit trackers
            this.nukeOrbitAngle = this.camera.position.x > 0 ? 0 : Math.PI;
            // Start camera closer, we will zoom out progressively
            this.nukeCameraDist = this.aircraft ? this.aircraft.mesh.position.distanceTo(groundZero) + 1500 : 3000;
        });

        window.addEventListener('resize', this.onWindowResize.bind(this), false);

        window.addEventListener('keydown', (e) => {
            if (e.code === 'KeyC') this.toggleView();
        });

        window.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (this.viewMode === 'chase' || this.viewMode === 'orbit') {
                const distSpeed = 0.01;
                this.cameraDistanceMult = THREE.MathUtils.clamp(this.cameraDistanceMult + e.deltaY * distSpeed, 0.5, 8.0);
            } else if (this.viewMode === 'cockpit') {
                const fovSpeed = 0.2;
                this.camera.fov = THREE.MathUtils.clamp(this.camera.fov + e.deltaY * fovSpeed, 30, 100);
                this.camera.updateProjectionMatrix();
            }
        }, { passive: false });

        window.addEventListener('trumpEasterEgg', () => {
            if (!this.trumpActive && this.world && this.world.trumpModel) {
                console.log("EASTER EGG ACTIVATED!");
                this.trumpActive = true;
                this.trumpTimer = 0;
                this.trumpDestroyCount = 0;
                this.world.trumpModel.visible = true;

                // Start looping Trump audio
                if (!this.trumpAudio) {
                    this.trumpAudio = new Audio('./src/assets/trump_bing_bong.mp3');
                    this.trumpAudio.loop = true;
                    this.trumpAudio.volume = 1.0; 
                    
                    // Boost volume beyond 1.0 using Web Audio API GainNode
                    try {
                        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                        this.trumpGainNode = audioCtx.createGain();
                        this.trumpGainNode.gain.value = 1.5; // 50% boost
                        
                        const source = audioCtx.createMediaElementSource(this.trumpAudio);
                        source.connect(this.trumpGainNode);
                        this.trumpGainNode.connect(audioCtx.destination);
                    } catch (e) {
                        console.warn('Web Audio API not supported or blocked, falling back to standard volume max.', e);
                    }
                }
                this.trumpAudio.currentTime = 0;
                this.trumpAudio.play().catch(() => { });
            }
        });

        this.animate();
    }

    updateKillCounter() {
        const counter = document.getElementById('kill-counter');
        if (counter) {
            counter.innerText = `HOSTILES: ${this.hostilesRemaining}`;
        }
    }

    getRandomSpawnPosition(isAirship) {
        const phi = Math.acos(2 * Math.random() - 1);
        const theta = Math.random() * Math.PI * 2;
        // Expanded small adversary spawn distance: 8,000 to 20,000
        const radius = isAirship ? (20000 + Math.random() * 50000) : (8000 + Math.random() * 12000);

        return new THREE.Vector3(
            radius * Math.sin(phi) * Math.cos(theta),
            isAirship ? 7500 : (1500 + Math.abs(radius * Math.sin(phi) * Math.sin(theta) * 0.5)),
            radius * Math.cos(phi)
        );
    }

    wrapDestroyCallback(adv) {
        const originalDestroy = adv.destroy.bind(adv);
        adv.destroy = () => {
            if (!adv.isDestroyed) {
                this.hostilesRemaining--;
                this.updateKillCounter();

                // Progressive Difficulty for Small Adversaries
                if (!adv.isAirship) {
                    this.smallHostilesKilled++;
                    if (this.smallHostilesKilled % 10 === 0) {
                        console.log(`Small Hostiles Killed: ${this.smallHostilesKilled}. Increasing Difficulty!`);
                        this.adversaries.forEach(a => {
                            if (a.increaseDifficulty) a.increaseDifficulty(1.1); // +10% Speed
                        });
                    }

                    // --- PHASE 2: Spawn Giants when all smalls are dead ---
                    if (this.smallHostilesKilled >= this.adversaryCount && !this.giantsSpawned) {
                        console.log("ALL SMALL HOSTILES ELIMINATED! SPAWNING GIANTS!");
                        this.spawnGiants();
                    }
                }

                // Trigger Mega Explosion
                if (this.aircraft && this.aircraft.cannon) {
                    this.aircraft.cannon.createMegaExplosion(adv.mesh.position);
                }

                // --- VICTORY CHECK ---
                if (this.hostilesRemaining <= 0 && !this.victoryTriggered) {
                    console.log("ALL HOSTILES ELIMINATED! TRIGGERING VICTORY!");
                    setTimeout(() => this.triggerVictory(), 2000); // 2 sec delay for drama
                }
            }
            originalDestroy();
        };
    }

    spawnGiants() {
        this.giantsSpawned = true;
        this.hostilesRemaining += this.giantCount;
        this.updateKillCounter();

        const airshipPositions = [];
        const minSeparation = 15000;

        for (let i = 0; i < this.giantCount; i++) {
            let startPos;
            let attempts = 0;

            do {
                startPos = this.getRandomSpawnPosition(true);

                if (airshipPositions.length > 0) {
                    let tooClose = false;
                    for (const pos of airshipPositions) {
                        if (startPos.distanceTo(pos) < minSeparation) {
                            tooClose = true;
                            break;
                        }
                    }
                    if (!tooClose) break;
                } else {
                    break;
                }
                attempts++;
            } while (attempts < 100);

            airshipPositions.push(startPos.clone());

            const adv = new Adversary(this.scene, this.input, {
                startPosition: startPos,
                seed: Math.random(),
                isAirship: true
            });

            // Face the player
            if (this.aircraft && this.aircraft.mesh) {
                adv.mesh.lookAt(this.aircraft.mesh.position);
            } else {
                adv.mesh.lookAt(new THREE.Vector3(0, 600, 0));
            }

            this.wrapDestroyCallback(adv);
            adv._allAdversaries = this.adversaries; // Share reference for separation force
            this.adversaries.push(adv);
        }

        console.log(`Spawned ${this.giantCount} Giants. Total hostiles remaining: ${this.hostilesRemaining}`);
    }

    triggerVictory() {
        if (this.victoryTriggered) return;
        this.victoryTriggered = true;
        this.started = false; // Stop game updates

        console.log("=== VICTORY CINEMATIC STARTING ===");

        // 1. Stop background music
        if (this.bgMusic) {
            this.bgMusic.pause();
            this.bgMusic.currentTime = 0;
        }

        // 2. Stop engine sound
        if (this.aircraft && this.aircraft.engineSound) {
            this.aircraft.engineSound.pause();
        }

        // 3. Hide the ENTIRE game UI (container, HUD, canvas, overlays — everything)
        const gameContainer = document.getElementById('game-container');
        if (gameContainer) gameContainer.style.display = 'none';
        const instructions = document.getElementById('instructions');
        if (instructions) instructions.style.display = 'none';
        // Also hide the game renderer canvas directly
        if (this.renderer && this.renderer.domElement) {
            this.renderer.domElement.style.display = 'none';
        }

        // 4. Show victory-text overlay (opacity 0 initially — VictoryScene fades it in)
        const vText = document.getElementById('victory-text');
        if (vText) {
            vText.style.display = 'block';
            vText.style.zIndex = '200';
        }

        // 5. Launch VictoryScene (it creates its own renderer/canvas)
        const victory = new VictoryScene();
        // Ensure the new canvas fills the viewport
        victory.renderer.domElement.style.position = 'absolute';
        victory.renderer.domElement.style.top = '0';
        victory.renderer.domElement.style.left = '0';
        victory.renderer.domElement.style.zIndex = '50';
        victory.startAudio();
        victory.animate();
    }

    playIntroVideo() {
        if (this.introPlaying) return;
        this.introPlaying = true;

        const videoContainer = document.getElementById('intro-video-container');
        const video = document.getElementById('intro-video');

        if (!videoContainer || !video) {
            this.startGame();
            return;
        }

        // --- SILENCE ALL AUDIO AND UNLOCK ---
        // 1. Background Music
        if (this.bgMusic) {
            if (this.bgMusic.paused) {
                this.bgMusic.play().catch(e => { }); // Attempt unlock
            }
            this.bgMusic.pause();
        }

        // 2. Engine Sound
        if (this.aircraft && this.aircraft.engineSound) {
            if (this.aircraft.engineSound.paused) {
                this.aircraft.engineSound.play().catch(e => { }); // Attempt unlock
            }
            this.aircraft.engineSound.pause();
            this.aircraft.audioStarted = true;
        }

        videoContainer.style.display = 'block';
        video.play().catch(e => {
            console.log("Video play failed:", e);
            this.endIntroVideo();
        });

        // Skip listener
        this.skipListener = (e) => {
            if (e.key === 's' || e.key === 'S') {
                this.endIntroVideo();
            }
        };
        document.addEventListener('keydown', this.skipListener);

        // Video end listener
        video.onended = () => {
            this.endIntroVideo();
        };
    }

    endIntroVideo() {
        if (!this.introPlaying) return;
        this.introPlaying = false;

        const videoContainer = document.getElementById('intro-video-container');
        const video = document.getElementById('intro-video');

        if (video) {
            video.pause();
            video.onended = null;
        }
        if (videoContainer) {
            videoContainer.style.display = 'none';
        }

        if (this.skipListener) {
            document.removeEventListener('keydown', this.skipListener);
            this.skipListener = null;
        }

        this.startGame();
    }

    startGame() {
        this.started = true;
        // Resume background music after video
        if (this.bgMusic && this.bgMusic.paused) {
            this.bgMusic.play().catch(e => console.log('Background music resume failed:', e));
        }
        // Start/resume engine sound
        if (this.aircraft && this.aircraft.startEngineSound) {
            this.aircraft.startEngineSound();
        }
    }

    initCustomizePanel() {
        const panel = document.getElementById('customize-panel');
        const skinInput = document.getElementById('skin-upload-input');
        const skinText = document.getElementById('skin-upload-text');
        const skinStatus = document.getElementById('skin-status');
        const colorPicker = document.getElementById('aircraft-color-picker');
        const resetBtn = document.getElementById('reset-appearance-btn');
        const removeSkinBtn = document.getElementById('remove-skin-btn');
        const doneBtn = document.getElementById('customize-done-btn');

        if (!panel) return;

        // Load saved color into picker
        try {
            const saved = JSON.parse(localStorage.getItem('aircraftAppearance'));
            if (saved && saved.type === 'color') colorPicker.value = saved.hex;
            if (saved && saved.type === 'skin') {
                skinText.textContent = '✓ Custom skin loaded';
                skinStatus.textContent = 'Saved skin will be applied';
                if (removeSkinBtn) removeSkinBtn.style.display = 'block';
            }
        } catch (e) { }

        // Skin Upload
        skinInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            skinText.textContent = file.name;
            skinStatus.textContent = 'Processing...';

            const reader = new FileReader();
            reader.onload = (ev) => {
                const dataURL = ev.target.result;
                // Save to localStorage
                localStorage.setItem('aircraftAppearance', JSON.stringify({
                    type: 'skin',
                    dataURL: dataURL
                }));
                // Apply immediately
                if (this.aircraft) this.aircraft.applySkin(dataURL);
                skinStatus.textContent = '✓ Skin saved!';
                if (removeSkinBtn) removeSkinBtn.style.display = 'block';
            };
            reader.readAsDataURL(file);
        });

        // Color Picker
        colorPicker.addEventListener('input', (e) => {
            const hex = e.target.value;
            localStorage.setItem('aircraftAppearance', JSON.stringify({
                type: 'color',
                hex: hex
            }));
            if (this.aircraft) this.aircraft.applyColor(hex);
            skinText.textContent = '📁 Choose Image (PNG/JPG)...';
            skinStatus.textContent = '';
            if (removeSkinBtn) removeSkinBtn.style.display = 'none';
        });

        // Reset
        resetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            localStorage.removeItem('aircraftAppearance');
            if (this.aircraft) this.aircraft.resetSkin();
            skinText.textContent = '📁 Choose Image (PNG/JPG)...';
            skinStatus.textContent = 'Reset to default';
            colorPicker.value = '#888888';
            skinInput.value = '';
            if (removeSkinBtn) removeSkinBtn.style.display = 'none';
        });

        // Remove Skin Button Cross
        if (removeSkinBtn) {
            removeSkinBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Clear from storage
                localStorage.removeItem('aircraftAppearance');

                // Revert aircraft to default original loaded skin
                if (this.aircraft) this.aircraft.resetSkin();

                // Reset UI
                skinText.textContent = '📁 Choose Image (PNG/JPG)...';
                skinStatus.textContent = 'Custom skin removed';
                skinInput.value = '';
                removeSkinBtn.style.display = 'none';
                colorPicker.value = '#888888'; // Optional: clear color picker as well if resetting fully
            });
        }

        // Done — close panel
        doneBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            panel.style.display = 'none';
        });
    }

    initBackgroundMusic() {
        this.bgMusic = new Audio('./src/assets/run_amok.mp3');
        this.bgMusic.loop = true;
        this.bgMusic.volume = 0.79; // Increased by 20% again

        // Attempt to play immediately (Works if Autoplay is allowed)
        this.bgMusic.play().catch(() => {
            console.log("Autoplay blocked. Waiting for interaction.");
        });

        // Start music on first user interaction (required by browsers if autoplay failed)
        const startMusic = (e) => {
            if (this.introPlaying) return; // Never play if video is playing
            if (this.bgMusic.paused) {
                this.bgMusic.play().catch(e => console.log('Background music play failed:', e));
            }
        };

        document.addEventListener('click', startMusic, { once: true });
        document.addEventListener('keydown', startMusic, { once: true });
        document.addEventListener('mousemove', startMusic, { once: true }); // Adding mousemove to trigger earlier
    }

    toggleView() {
        // Cycle: Chase -> Cockpit -> Orbit -> Chase
        // Cycle: Chase -> Cockpit -> Orbit -> Chase
        if (this.viewMode === 'chase') {
            this.viewMode = 'cockpit';
            this.controls.enabled = false;
        } else if (this.viewMode === 'cockpit') {
            this.viewMode = 'orbit';
            this.controls.enabled = true;

            // Determine Camera Target
            let targetObj = this.aircraft;
            if (this.cameraTargetType === 'adversary') {
                targetObj = this.adversaries[this.cameraTargetIdx];
            }
            const camScale = targetObj.cameraScale || 1.0;

            // Initialize Last Position for tracking
            this.lastOrbitPos = targetObj.mesh.position.clone();

            // Set Initial Hero Position relative to aircraft
            // Side/Front view to see the livery clearly
            const heroOffset = new THREE.Vector3(15 * camScale, 5 * camScale, 15 * camScale);
            const heroPos = heroOffset.applyMatrix4(targetObj.mesh.matrixWorld);
            this.camera.position.copy(heroPos);
            this.controls.target.copy(targetObj.mesh.position);
            this.controls.update();

        } else {
            this.viewMode = 'chase';
            this.controls.enabled = false;
            this.lastOrbitPos = null;
        }

        console.log("View Mode:", this.viewMode);

        const overlay = document.getElementById('cockpit-overlay');
        if (overlay) {
            overlay.style.display = this.viewMode === 'cockpit' ? 'block' : 'none';
        }

        if (this.aircraft && this.aircraft.mesh) {
            this.aircraft.mesh.visible = this.viewMode !== 'cockpit' || this.cameraTargetType !== 'aircraft';
        }
    }

    toggleTarget() {
        if (this.cameraTargetType === 'aircraft') {
            // Switch to Adversary View
            this.cameraTargetType = 'adversary';

            // Find first Regular Adversary (Scale 300) for inspection
            const firstRegular = this.adversaries.findIndex(a => !a.isAirship);
            this.cameraTargetIdx = (firstRegular !== -1) ? firstRegular : 0;

            // Disable Aircraft Control, Enable Adversary Control (for testing)
            if (this.aircraft) this.aircraft.manualControl = false;
            this.adversaries.forEach((a, i) => a.manualControl = (i === this.cameraTargetIdx));

            console.log(`Switched to Adversary ${this.cameraTargetIdx}`);
        } else {
            // Switch BACK to Aircraft View (Instant Toggle)
            this.cameraTargetType = 'aircraft';

            // Restore Aircraft Control
            if (this.aircraft) this.aircraft.manualControl = true;
            // Disable all adversary control
            this.adversaries.forEach(a => a.manualControl = false);

            console.log("Control Restored: Aircraft");
        }

        // Update visibility on switch
        if (this.aircraft && this.aircraft.mesh) {
            this.aircraft.mesh.visible = true; // Always visible when viewing adversary
        }
        this.toggleView(); // Reset/refresh view
    }

    onWindowResize() {
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
    }

    updateHUD() {
        let activeObj = this.aircraft;
        if (this.cameraTargetType === 'adversary') {
            activeObj = this.adversaries[this.cameraTargetIdx];
        }

        if (!activeObj || !activeObj.mesh) return;

        const speedKph = activeObj.getKph ? activeObj.getKph() : Math.floor(activeObj.speed * 200); // Fallback for adversary if getKph missing
        const throttlePct = Math.floor(activeObj.throttle * 100);
        const altitude = Math.floor(activeObj.position.y);
        const heading = Math.floor((activeObj.mesh.rotation.y * (180 / Math.PI)) % 360);

        const euler = new THREE.Euler();
        euler.setFromQuaternion(activeObj.mesh.quaternion, 'YXZ');

        const pitchRad = euler.x;
        const rollRad = -euler.z;

        const pitchDeg = THREE.MathUtils.radToDeg(pitchRad);
        const rollDeg = THREE.MathUtils.radToDeg(rollRad);


        const elSpeed = document.getElementById('speed');
        if (elSpeed) elSpeed.innerText = `${speedKph} kph`;

        const elThr = document.getElementById('throttle');
        if (elThr) elThr.innerText = `THR: ${throttlePct}%`;

        const elAmmo = document.getElementById('ammo');
        if (elAmmo && activeObj.cannon) {
            elAmmo.innerText = `AMMO: ${activeObj.cannon.ammo}`;
        }

        const elAlt = document.getElementById('altitude');
        if (elAlt) elAlt.innerText = `ALT: ${altitude * 4}`; // Engine 15k = HUD 60k feet

        const elHdg = document.getElementById('heading');
        if (elHdg) elHdg.innerText = `HDG: ${heading < 0 ? heading + 360 : heading}`;

        const instrument = document.getElementById('horizon-instrument');
        if (instrument) {
            instrument.style.transform = `rotate(${-rollDeg}deg)`;
        }

        const pitchFactor = 2.0;
        const yOffset = pitchDeg * pitchFactor;

        const sky = document.getElementById('horizon-sky');
        const ground = document.getElementById('horizon-ground');

        if (sky && ground) {
            sky.style.transform = `translateY(calc(-25% + ${yOffset}px))`;
            ground.style.transform = `translateY(calc(25% + ${yOffset}px))`;
        }

        // Update Health Bar
        const healthFill = document.getElementById('health-fill');
        const healthText = document.getElementById('health-text');

        if (healthFill && healthText && activeObj.health !== undefined && activeObj.maxHealth) {
            const pct = Math.max(0, (activeObj.health / activeObj.maxHealth) * 100);

            // Width
            healthFill.style.width = `${pct}%`;

            // Text
            healthText.innerText = `${Math.ceil(pct)}%`;

            // Color Gradient (HSL)
            // 100% = 120 (Green), 0% = 0 (Red)
            const hue = (pct * 1.2);
            healthFill.style.background = `hsl(${hue}, 100%, 50%)`;
        }

        // Update Radar
        const radarBlips = document.getElementById('radar-blips');
        if (radarBlips && this.aircraft && this.aircraft.mesh) {
            // clear previous blips
            radarBlips.innerHTML = '';

            const range = 60000; // 60km Range Coverage
            const radarRadius = 110; // Half of 220px width/height

            const playerPos = this.aircraft.mesh.position;
            const playerRot = this.aircraft.mesh.rotation.y;

            const radarCenter = document.getElementById('radar-center');
            const radarArc = document.getElementById('radar-arc');

            this.adversaries.forEach(adv => {
                if (adv.isDestroyed || !adv.mesh) return;

                // Relative Position
                const dx = adv.mesh.position.x - playerPos.x;
                const dz = adv.mesh.position.z - playerPos.z;

                // Rotate to match Player Heading (Radar is always "User-Up" orientation)
                // Let's do "Player-Up" (Forward is Up on radar)
                // Rotate vector (dx, dz) by -playerRot
                const cos = Math.cos(playerRot);
                const sin = Math.sin(playerRot);
                const rx = dx * cos - dz * sin;
                const rz = dx * sin + dz * cos;

                // Check Range
                if (Math.abs(rx) < range && Math.abs(rz) < range) {
                    // Map to pixels
                    // Forward (Negative Z in 3D) is Up (Negative Y in CSS? No, Top is 0)
                    // In 3D: Forward is -Z. Right is +X.
                    // In 2D Radar: Up is -Y, Right is +X.

                    // So -rz corresponds to Up (-Y). 
                    // rx corresponds to Right (+X).

                    const x = (rx / range) * radarRadius;
                    const y = (rz / range) * radarRadius;

                    // Distance Check for Circle Clipping
                    if (x * x + y * y < radarRadius * radarRadius) {
                        const blip = document.createElement('div');
                        blip.className = 'radar-blip';
                        if (adv.isAirship) blip.classList.add('airship');

                        // Center (110, 110) + offset
                        blip.style.left = `${110 + x}px`;
                        blip.style.top = `${110 + y}px`;
                        radarBlips.appendChild(blip);
                    }
                }
            });
        }
    }

    animate() {
        requestAnimationFrame(this.animate.bind(this));

        const delta = this.clock.getDelta();

        if (this.started) {

            if (this.trumpActive && this.world && this.world.trumpModel) {
                this.trumpTimer += delta;

                // One full circle (2*PI) in 20 seconds = 0.314 rads/sec
                const fullCircleDuration = 20.0;
                const walkSpeedRads = (2 * Math.PI) / fullCircleDuration;
                const angle = this.trumpTimer * walkSpeedRads;
                const radius = 6000;

                const tx = Math.cos(angle) * radius;
                const tz = Math.sin(angle) * radius;
                // Only set X and Z on the group — Y comes from terrain only, 
                // the inner model's Y offset is baked in by World.js and must not be overwritten!
                const terrainY = this.world.getProceduralHeight(tx, tz);

                this.world.trumpModel.position.x = tx;
                this.world.trumpModel.position.z = tz;
                this.world.trumpModel.position.y = terrainY; // group sits on terrain

                // Make him face the direction of travel (tangent to the circle)
                this.world.trumpModel.rotation.y = -angle - Math.PI / 2;

                // Kill 1 enemy every 2 seconds (10 kills over 20 seconds)
                const expectedKills = Math.floor(this.trumpTimer / 2.0);
                if (expectedKills > this.trumpDestroyCount) {
                    const activeAdversaries = this.adversaries.filter(a => !a.isDestroyed);
                    if (activeAdversaries.length > 0) {
                        const target = activeAdversaries[0];
                        target.health = 0;
                        // Only play death sound on the very first kill
                        const prevMute = target.muteDeathSound;
                        if (this.trumpDestroyCount > 0) target.muteDeathSound = true;
                        target.hit();
                        target.muteDeathSound = prevMute;
                    }
                    this.trumpDestroyCount++;
                }

                // After one full circle, stop walking but keep him visible
                if (this.trumpTimer >= fullCircleDuration) {
                    this.trumpActive = false;
                    // Stop the Trump audio loop
                    if (this.trumpAudio) {
                        this.trumpAudio.pause();
                        this.trumpAudio.currentTime = 0;
                    }
                    // Do NOT hide: this.world.trumpModel.visible = false;
                    // Check if victory should be triggered
                    const remaining = this.adversaries.filter(a => !a.isDestroyed);
                    if (remaining.length === 0 && !this.victoryTriggered) {
                        this.triggerVictory();
                    }
                }
            }

            // Update Doomsday Cinematic
            if (this.nuke) {
                this.nuke.update(delta);

                // Progressively zoom out to see the monstrous 25km explosion
                this.nukeCameraDist = THREE.MathUtils.lerp(this.nukeCameraDist, 40000, delta * 0.15);

                // Cinematic Slow Orbit
                this.nukeOrbitAngle += delta * 0.05;
                const camX = Math.cos(this.nukeOrbitAngle) * this.nukeCameraDist;
                const camZ = Math.sin(this.nukeOrbitAngle) * this.nukeCameraDist;
                // Bob dynamically based on distance to feel epic scale
                const camY = Math.max(1000, this.nukeCameraDist * 0.25) + (Math.sin(Date.now() * 0.0005) * 2000);

                this.camera.position.set(camX, camY, camZ);
                this.camera.lookAt(this.nuke.position);

                // Blast Physics: Vaporize the Temple and Oil Bottle
                if (this.nuke.currentRadius > 100) {
                    if (this.world && this.world.templeMesh && this.world.templeMesh.visible) {
                        this.world.templeMesh.visible = false;
                        console.log("TEMPLE VAPORIZED!");
                    }
                    if (this.babyOilMesh && this.babyOilMesh.visible) {
                        this.babyOilMesh.visible = false;
                        console.log("OIL BOTTLE VAPORIZED!");
                    }
                }

            }

            // Update All Adversaries
            const activeAdversaries = this.adversaries.filter(a => !a.isDestroyed);
            activeAdversaries.forEach(adv => adv.update(delta, this.world, this.aircraft, this.world.templeMesh));

            // Pass active adversaries to aircraft cannon for collision
            // Also pass oil bottle + temple so bullets can trigger game over / be occluded
            this.aircraft.update(delta, this.world, activeAdversaries, this.babyOilMesh, this.world.templeMesh, this.world.easterEggCube);
            this.aircraft.mesh.updateMatrixWorld();

            activeAdversaries.forEach(adv => {
                if (adv.mesh) adv.mesh.updateMatrixWorld();
            });

            this.world.update(this.aircraft.position);

            // Determine Camera Target
            let targetObj = this.aircraft;
            if (this.cameraTargetType === 'adversary') {
                targetObj = this.adversaries[this.cameraTargetIdx];
                // If current target is destroyed, cycle to aircraft or next?
                if (targetObj.isDestroyed) {
                    this.cameraTargetType = 'aircraft';
                    targetObj = this.aircraft;
                }
            }

            const camScale = targetObj.cameraScale || 1.0;

            if (this.viewMode === 'cockpit') {
                // Cockpit Camera
                // Scale offset so we aren't inside the mesh for giants, 
                // or use a fixed sensible offset if scale is too high.
                const finalCockpitZ = -2 * camScale;
                const cockpitOffsetVec = new THREE.Vector3(0, 1.5 * camScale, finalCockpitZ);
                const cameraPos = cockpitOffsetVec.applyMatrix4(targetObj.mesh.matrixWorld);
                this.camera.position.copy(cameraPos);
                this.camera.quaternion.copy(targetObj.mesh.quaternion);
            }
            else if (this.viewMode === 'chase' && !this.nuke) {
                // Chase Camera: Behind and above aircraft
                // Physical Zoom Applied: Dolly back based on cameraDistanceMult
                // Slightly Higher angle (1.5) to see the aircraft from above
                const relativeCameraOffset = new THREE.Vector3(
                    0,
                    1.5 * camScale * this.cameraDistanceMult,
                    12 * camScale * this.cameraDistanceMult
                );
                const cameraOffset = relativeCameraOffset.applyMatrix4(targetObj.mesh.matrixWorld);

                // Supersonic Rigid Framing: posDamp = 1.0 (zero lag)
                const rotDamp = 1.0 - Math.pow(0.01, delta);
                const posDamp = 1.0;

                this.camera.position.lerp(cameraOffset, posDamp);
                this.camera.quaternion.slerp(targetObj.mesh.quaternion, rotDamp);
            }
            else if (this.viewMode === 'orbit') {
                // Orbit Mode: Camera MUST follow the Aircraft manually
                // Otherwise the plane flies away from the camera faster than OrbitControls can update

                const currentPos = targetObj.mesh.position.clone();

                if (this.lastOrbitPos) {
                    const movementDelta = currentPos.clone().sub(this.lastOrbitPos);
                    this.camera.position.add(movementDelta);
                }

                this.lastOrbitPos = currentPos;

                // Update target to maintain focus
                this.controls.target.copy(currentPos);
                this.controls.update();
            }

            if (!this.nuke) {
                this.updateHUD();
            }
        }

        this.renderer.render(this.scene, this.camera);
    }

    loadSpawnModel() {
        const loader = new GLTFLoader();
        this.babyOilMesh = null; // Will be set when the model finishes loading
        loader.load('./src/assets/paper_model/source/document_file_folder (2).glb', (gltf) => {
            const babyOil = gltf.scene;

            // Initial position at spawn point (shifted forward, left, down and rotated)
            babyOil.position.copy(this.aircraft.position);
            babyOil.position.z -= 2500; // Forward
            babyOil.position.x -= 500;  // Left
            babyOil.position.y -= 800;  // Down
            babyOil.rotation.y = Math.PI; // Turn right 180 degrees
            babyOil.rotation.x = -Math.PI / 2; // Stand the file vertically
            this.scene.add(babyOil);
            this.babyOilMesh = babyOil; // Store reference for bullet collision & nuke

            // Enable shadows
            babyOil.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                }
            });

            // Handle Scaling relative to the temple
            // The temple might load after the baby oil, so we check in an interval
            let scaleAttempt = 0;
            const checkTemple = setInterval(() => {
                scaleAttempt++;
                if (this.world && this.world.templeMesh) {
                    clearInterval(checkTemple);

                    // 1. Get Temple Height
                    const templeBox = new THREE.Box3().setFromObject(this.world.templeMesh);
                    const templeHeight = templeBox.max.y - templeBox.min.y;

                    // 2. Get Baby Oil Base Height
                    const babyBox = new THREE.Box3().setFromObject(babyOil);
                    const babyBaseHeight = babyBox.max.y - babyBox.min.y;

                    if (templeHeight > 0 && babyBaseHeight > 0) {
                        const targetHeight = templeHeight / 5.0; // 1/5th height
                        const scaleFactor = targetHeight / babyBaseHeight;

                        babyOil.scale.set(scaleFactor, scaleFactor, scaleFactor);

                        // Adjust position so it sits on the ground at spawn coordinates if needed
                        console.log(`Baby Oil scaled to ${scaleFactor.toFixed(4)} (1/5th of temple height: ${templeHeight.toFixed(2)})`);
                    }
                }

                if (scaleAttempt > 100) clearInterval(checkTemple); // Give up after 10s
            }, 100);

        }, undefined, (error) => {
            console.error('Error loading paper model:', error);
        });
    }
}

window.game = new Game();
export { Game };
