import * as THREE from 'three';
import { Aircraft } from './Aircraft.js';
import { World } from './World.js';

class VictoryScene {
    constructor() {
        this.container = document.body;
        this.clock = new THREE.Clock();

        // 1. Setup Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x87CEEB);
        this.scene.fog = new THREE.Fog(0x87CEEB, 20000, 100000);

        // 2. Camera (Third Person Cinematic)
        this.camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 1, 100000);
        // Position camera adjacent to the temple looking at the flyby path
        this.camera.position.set(20000, 1500, 400); // Shifted WAY out of the temple geometry
        this.camera.lookAt(15000, 1500, -1000);

        // 3. Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.shadowMap.enabled = true;
        this.container.appendChild(this.renderer.domElement);

        // 4. Lighting
        const ambient = new THREE.AmbientLight(0x666666);
        this.scene.add(ambient);
        const sunlight = new THREE.DirectionalLight(0xffffff, 1.0);
        sunlight.position.set(1000, 2000, 500);
        sunlight.castShadow = true;
        this.scene.add(sunlight);

        // 5. World (Terrain)
        this.world = new World(this.scene);

        // 6. Aircraft (Spawned far behind camera)
        this.aircraft = new Aircraft(this.scene, {
            isDown: () => false // Mock Input: No keys pressed
        }, {
            startPosition: new THREE.Vector3(15000, 1500, 15000), // Start FAR behind camera and completely outside temple bounds
            audioEnabled: false // Disable engine sound for preview
        });

        // Force manual control off so physics doesn't interfere with our scripting
        this.aircraft.manualControl = false;

        // --- CUSTOM SCALING ---
        // Setting aircraft scale to exactly match temple scaling (15.0) 
        this.aircraft.mesh.scale.set(15.0, 15.0, 15.0); // Make it HUGE for the cinematic

        // FLARES
        this.flares = [];

        // ANIMATION STATE
        this.state = 'APPROACH'; // APPROACH, PULLUP, VICTORY
        this.flybySpeed = 60; // Much faster approach (Was 15)
        this.flareTimer = 0; // Timer for flare release (Initialize here!)
        this.minTerrainClearance = 300; // Minimum altitude above terrain during cinematic

        // --- AUDIO ---
        this.epsteinAudio = new Audio('./src/assets/We are Jeffery Epstein (Official Audio).mp3');
        this.epsteinAudio.volume = 1.0; // Increased base volume

        this.jetRumble = new Audio('./src/assets/engine_ambience.mp3');
        this.jetRumble.loop = true;
        this.jetRumble.volume = 0.2; // Reduced jet rumble volume
        this.jetRumble.currentTime = 120; // Skip to the good part (same as main game)
        this.jetRumble.playbackRate = 1.4; // Full throttle pitch

        this.flybySound = new Audio('./src/assets/freesound_community-f-106-fly-by-98385.mp3');
        this.flybySound.volume = 0.8;
        this.flybyPlayed = false;

        this.audioStarted = false;

        // DON'T auto-animate; wait for user click
        // this.animate();

        // Resize handler
        window.addEventListener('resize', () => {
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
        });
    }

    updateScript(delta) {
        if (!this.aircraft || !this.aircraft.mesh) return;

        if (this.audioStarted) {
            if (this.epsteinAudio && !this.epsteinAudio.paused) {
                // 2-second fade out from 13s to 15s
                if (this.epsteinAudio.currentTime >= 13 && this.epsteinAudio.currentTime < 15) {
                    const fadeProgress = (this.epsteinAudio.currentTime - 13) / 2.0; // 0.0 to 1.0
                    // Volume goes from 1.0 down to 0.0
                    this.epsteinAudio.volume = Math.max(0, 1.0 - fadeProgress);
                } else if (this.epsteinAudio.currentTime >= 15) {
                    this.epsteinAudio.pause();
                    this.epsteinAudio.volume = 0; // Ensure it's fully muted
                    // No background music playing afterward, just silence/SFX
                }
            }
        }

        const pos = this.aircraft.mesh.position;
        const rot = this.aircraft.mesh.rotation;

        // Ensure manual control is off every frame just in case
        this.aircraft.manualControl = false;
        this.aircraft.throttle = 1.0; // Full afterburner for metrics

        if (this.state === 'APPROACH') {
            // Move along -Z axis (Forward for model)
            const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.aircraft.mesh.quaternion);
            pos.add(forward.multiplyScalar(this.flybySpeed * delta));

            // --- TERRAIN AVOIDANCE ---
            // Query terrain height below the aircraft and ensure minimum clearance
            if (this.world && this.world.getHeightAt) {
                const terrainHeight = this.world.getHeightAt(pos.x, pos.z);
                const minAltitude = terrainHeight + this.minTerrainClearance;
                if (pos.y < minAltitude) {
                    // Smoothly raise the aircraft above terrain
                    pos.y = pos.y + (minAltitude - pos.y) * Math.min(1.0, 3.0 * delta);
                }
            }

            // Camera Tracking: Look at aircraft
            this.camera.lookAt(pos);

            // Slight Zoom during horizontal flight (Increased per request)
            if (this.camera.fov > 18) {
                this.camera.fov -= 15 * delta;
                this.camera.updateProjectionMatrix();
            }

            // Keep camera above terrain too
            if (this.world && this.world.getHeightAt) {
                const camTerrainHeight = this.world.getHeightAt(this.camera.position.x, this.camera.position.z);
                const minCamAlt = camTerrainHeight + 200;
                if (this.camera.position.y < minCamAlt) {
                    this.camera.position.y = minCamAlt;
                }
            }

            // Audio: Fade in jet rumble as aircraft approaches
            if (this.jetRumble) {
                this.jetRumble.volume = Math.min(this.jetRumble.volume + 0.3 * delta, 0.7);
            }

            // Phase Change: When it safely passes the temple
            if (pos.z < -600) {
                this.state = 'PULLUP';
                console.log("Phase: PULLUP");

                // Trigger flyby whoosh
                if (this.flybySound && !this.flybyPlayed) {
                    this.flybySound.play().catch(() => { });
                    this.flybyPlayed = true;
                }
            }
        }
        else if (this.state === 'PULLUP') {
            // Pitch up - Smoothed with Lerp (Ultra Smooth)
            const targetPitch = 1.57; // Vertical
            this.aircraft.mesh.rotation.x = THREE.MathUtils.lerp(this.aircraft.mesh.rotation.x, targetPitch, 0.6 * delta);

            // Bank left (roll) to expose belly/top to camera - Smoothed with Lerp
            const targetBank = -0.7; // rad
            this.aircraft.mesh.rotation.z = THREE.MathUtils.lerp(this.aircraft.mesh.rotation.z, targetBank, 2.0 * delta);

            // Move forward (follows pitch)
            const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.aircraft.mesh.quaternion);
            pos.add(forward.multiplyScalar(this.flybySpeed * delta));

            // Camera Panning to follow the climb
            this.camera.position.z -= 100 * delta;
            this.camera.lookAt(pos);

            // Progressive Aggressive Zoom (Decrease FOV) - Slightly increased
            if (this.camera.fov > 10) {
                this.camera.fov -= 20 * delta;
                this.camera.updateProjectionMatrix();
            }

            // Flare Logic (Timer Based)
            if (this.aircraft.mesh.rotation.x > 0.1) { // Start much earlier (approx 5 deg)
                if (typeof this.flareTimer === 'undefined' || isNaN(this.flareTimer)) this.flareTimer = 0;

                this.flareTimer += delta;
                // Fire more frequently (every 100ms instead of 150ms for denser effect)
                if (this.flareTimer > 0.1) {
                    this.createFlare(pos.clone(), this.aircraft.mesh.quaternion);
                    this.flareTimer = 0;
                }
            }

            // Transition to Text
            // User requested longer climb
            if (pos.y > 5000) {
                this.state = 'VICTORY';
                console.log("Phase: VICTORY");
                const vText = document.getElementById('victory-text');
                if (vText) vText.style.opacity = 1;
            }
        }
        else if (this.state === 'VICTORY') {
            // Continue flying off into space
            const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.aircraft.mesh.quaternion);
            pos.add(forward.multiplyScalar(this.flybySpeed * delta));

            // Camera stops tracking or drifts slowly
            this.camera.position.y += 10 * delta;
            this.camera.lookAt(pos);

            // Audio: Fade out jet rumble as aircraft flies away
            if (this.jetRumble && this.jetRumble.volume > 0) {
                this.jetRumble.volume = Math.max(this.jetRumble.volume - 0.15 * delta, 0);
            }
        }

        // Update Flares
        for (let i = this.flares.length - 1; i >= 0; i--) {
            const f = this.flares[i];
            f.userData.life -= delta;

            // Physics
            f.userData.velocity.y -= 50 * delta; // Gravity
            f.userData.velocity.multiplyScalar(0.98); // Drag
            f.mesh.position.add(f.userData.velocity.clone().multiplyScalar(delta));

            // Fade out
            f.mesh.material.opacity = f.userData.life / 3.0;

            if (f.userData.life <= 0) {
                this.scene.remove(f.mesh);
                this.flares.splice(i, 1);
            }
        }
    }

    createFlare(origin, orientation) {
        const geometry = new THREE.SphereGeometry(3, 8, 8);
        const material = new THREE.MeshBasicMaterial({
            color: 0xffffff, // Hot white center
            transparent: true,
            opacity: 1.0
        });
        const mesh = new THREE.Mesh(geometry, material);

        // Offset slightly behind aircraft
        const offset = new THREE.Vector3((Math.random() - 0.5) * 10, -5, 10).applyQuaternion(orientation);
        mesh.position.copy(origin).add(offset);

        // Burst velocity outward
        const ejectVel = new THREE.Vector3((Math.random() - 0.5) * 100, -20, (Math.random() - 0.5) * 20);
        ejectVel.applyQuaternion(orientation);

        this.scene.add(mesh);
        this.flares.push({ mesh: mesh, userData: { velocity: ejectVel, life: 3.0 } });
    }

    animate() {
        requestAnimationFrame(this.animate.bind(this));

        const delta = this.clock.getDelta();

        // Update World (Terrain generation)
        if (this.aircraft.mesh) {
            this.world.update(this.aircraft.mesh.position);

            // Run Aircraft internal updates (Exhausts, etc.)
            // We need to feed it a mock world if it expects one, or null
            this.aircraft.update(delta, this.world);
        }

        this.updateScript(delta);

        this.renderer.render(this.scene, this.camera);
    }

    startAudio() {
        if (this.audioStarted) return;
        this.audioStarted = true;
        this.epsteinAudio.play().catch(e => console.log('Epstein audio failed:', e));
        this.jetRumble.play().catch(e => console.log('Jet rumble failed:', e));
    }
}


export { VictoryScene };

// --- Standalone preview mode only (victory_preview.html) ---
// Only auto-setup if the start-overlay exists (preview page)
const overlay = document.getElementById('start-overlay');
if (overlay) {
    const scene = new VictoryScene();
    overlay.addEventListener('click', () => {
        overlay.style.display = 'none';
        scene.startAudio();
        scene.animate();
    });
}
