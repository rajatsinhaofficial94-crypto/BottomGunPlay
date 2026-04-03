import * as THREE from 'three';
import { STLLoader } from './lib/STLLoader.js';
import { Cannon } from './Cannon.js';
import { PizzaWeapon } from './PizzaWeapon.js';

export class Aircraft {
    constructor(scene, input, options = {}) {
        this.scene = scene;
        this.input = input;

        const {
            audioEnabled = true,
            startPosition = new THREE.Vector3(0, 600, 0)
        } = options;

        this.audioEnabled = audioEnabled;

        // Container for physics/logic
        this.mesh = new THREE.Group();
        scene.add(this.mesh);

        // Model Holder
        this.model = new THREE.Group();
        this.mesh.add(this.model);

        // Load STL Model
        this.loadModel();

        // Loop propeller dummy for update safety (even though jet doesn't have one visible)
        this.propeller = { rotation: { z: 0 } };

        this.speed = 0.5; // Start moving immediately
        this.maxSpeed = 100.0; // Supersonic max speed (was 50.0)
        this.position = startPosition.clone(); // Use passed start position

        this.exhaustScaleMult = 1.0; // Debug scale multiplier

        // We will now use the mesh's rotation directly for physics state
        this.mesh.position.copy(this.position);
        this.crashed = false;

        // Physics properties
        this.throttle = 0.5; // 0.0 to 1.0 (50% start)
        this.acceleration = 0;

        // Aerodynamics
        // Tuned so that at Max Thrust (2.0), Drag equals Thrust at Max Speed (2.0)
        // 2.0 = Cd * (2.0)^2  => Cd = 0.5
        this.dragCoefficient = 0.5;
        this.inducedDragFactor = 0.1; // Reduced induced drag even further

        // Engine Sound Setup
        this.engineSound = null;
        this.audioStarted = false;
        if (this.audioEnabled) {
            this.initEngineSound();
        }

        // Exhaust Setup
        this.initExhaust();

        this.manualControl = true; // Player aircraft starts with control
        this.cameraScale = 1.0;

        // Weapon System
        this.cannon = new Cannon(scene);
        this.pizzaWeapon = new PizzaWeapon(scene);
        this.pizzaKeyWasDown = false;

        // Health System
        this.maxHealth = 10;
        this.health = this.maxHealth;
        this.isInvulnerable = false;

        // alert("Aircraft Initialized V2"); // Commented out to avoid annoying popup every frame, but maybe needed once?
    }

    takeDamage(amount) {
        if (this.crashed || this.isInvulnerable) return;

        this.health -= amount;
        console.log(`Player Hit! Health: ${this.health}/${this.maxHealth}`);

        // Visual Shake / Flash? (Handled by HUD update usually)

        // Invulnerability frame (0.5s) to prevent double-hits
        this.isInvulnerable = true;
        setTimeout(() => { this.isInvulnerable = false; }, 500);

        if (this.health <= 0) {
            this.die();
        }
    }

    die() {
        this.crash(); // Legacy crash logic
    }

    initEngineSound() {
        this.engineSound = new Audio(new URL('./assets/engine_ambience.mp3', import.meta.url).href);
        this.engineSound.loop = true;
        this.engineSound.volume = 0.192; // Start at idle volume (reduced by another 20%)

        // Crash Sound
        this.crashSound = new Audio(new URL('./assets/fahhhhh.mp3', import.meta.url).href);
        this.crashSound.loop = false;
        this.crashSound.volume = 1.0;

        // Bonk Sound (Giant Collision)
        this.bonkSound = new Audio(new URL('./assets/bonk_BEtiM8g.mp3', import.meta.url).href);
        this.bonkSound.loop = false;
        this.bonkSound.volume = 1.0;

        // Skip first 120 seconds (intro)
        this.engineSound.currentTime = 120;

        // When looping, restart at 120 seconds instead of 0
        this.engineSound.addEventListener('timeupdate', () => {
            if (this.engineSound.currentTime < 120) {
                this.engineSound.currentTime = 120;
            }
        });

        // Start sound on first user interaction (required by browsers)
        // Removed document listeners; main.js will control audio unlock and playback.
    }

    startEngineSound() {
        if (!this.audioStarted && this.engineSound) {
            this.engineSound.currentTime = 120; // Ensure we start at 120s
            this.engineSound.play().catch(e => console.log('Audio play failed:', e));
            this.audioStarted = true;
        } else if (this.engineSound && this.engineSound.paused) {
            this.engineSound.play().catch(e => console.log('Audio resume failed:', e));
        }
    }

    playBonkSound() {
        if (!this.bonkSound) return;
        this.bonkSound.currentTime = 0.75; // Skip first 0.75 seconds
        this.bonkSound.play().catch(e => console.log('Bonk sound play failed:', e));
    }

    updateEngineSound() {
        if (!this.engineSound || !this.audioStarted) return;

        // Volume: 10% at idle, 70% at full throttle (Reduced based on user feedback)
        const minVolume = 0.064;
        const maxVolume = 0.448;
        this.engineSound.volume = minVolume + (this.throttle * (maxVolume - minVolume));

        // Playback rate: 0.8x at idle, 1.2x at full throttle (pitch change)
        const minRate = 0.8;
        const maxRate = 1.2;
        this.engineSound.playbackRate = minRate + (this.throttle * (maxRate - minRate));
    }

    loadModel() {
        const loader = new STLLoader();
        const textureLoader = new THREE.TextureLoader();

        // Load Texture
        const skinTexture = textureLoader.load(new URL('./assets/skin.png', import.meta.url).href);
        skinTexture.wrapS = THREE.RepeatWrapping;
        skinTexture.wrapT = THREE.RepeatWrapping;

        loader.load(
            new URL('./assets/f18scaled.stl', import.meta.url).href,
            (geometry) => {
                geometry.center();

                const posAttr = geometry.attributes.position;
                const count = posAttr.count;

                // Arrays for splitting geometry
                const fuselagePositions = [];
                const fuselageUVs = [];

                const nozzlePositions = [];

                const leftStabPositions = [];
                const leftStabUVs = [];
                const rightStabPositions = [];
                const rightStabUVs = [];

                // --- CONFIGURATION ---
                // Nozzle Bounds (Existing)
                const NOZZLE_Z_MIN = -42.12;
                const NOZZLE_Z_MAX = -34.92;
                const NOZZLE_Y_MIN = -8.85;
                const NOZZLE_Y_MAX = -3.34;
                const NOZZLE_X_ABS = 5.64;

                // Stabilizer Bounds (User Provided)
                // Left: X[-5.6, -1.4], Y[-1.7, -1.3], Z[8.4, 12.9]
                // Note: The model behaves differently in game vs debug tool due to transforms.
                // In Debug Tool: X is Left/Right.
                // In Game: The model is rotated Y=180.
                // The provided coordinates are likely from the Debug Tool (World Space there).
                // Let's assume the coordinates correspond to the "Entity Space" of the mesh.
                // - [x] Tighten collision radius (0.3 -> 0.2)
                // - [x] Implement giant collision sound("bonk")
                // - [] Verify behavior in -game space.
                // If coordinates came from the debug tool where the mesh was: rot.x=0, rot.y=PI, rot.z=0.
                // And the slider values were checked against `v.applyMatrix4(mesh.matrixWorld)`.
                // Then the coordinates are in "World Space" relative to that specific rotation.
                // Inside `loadModel, we are looking at raw vertex data *before* the mesh.rotation is applied in the scene, BUT
                // The debug tool applied the matrix before checking.
                // So we need to apply the SAME matrix (Scale 0.25, Rot Y 180) to our current vertices to check against the box.

                // Helper Matrix to match Debug Tool's transform for checking
                const debugMatrix = new THREE.Matrix4();
                const partRot = new THREE.Euler(0, Math.PI, 0); // Matches debug tool
                const partScale = new THREE.Vector3(0.25, 0.25, 0.25);
                const partPos = new THREE.Vector3(0, 0, 0);
                debugMatrix.compose(partPos, new THREE.Quaternion().setFromEuler(partRot), partScale);

                // Bounds
                // Left Stab
                const LS_Min = new THREE.Vector3(-5.6, -1.7, 8.4);
                const LS_Max = new THREE.Vector3(-1.4, -1.3, 12.9);

                // Right Stab (Mirrored X)
                const RS_Min = new THREE.Vector3(1.4, -1.7, 8.4);
                const RS_Max = new THREE.Vector3(5.6, -1.3, 12.9);


                // Left Rudder (User provided updated coords)
                // X[-3.1, -1.4], Y[-0.2, 3.1], Z[4.7, 9.4]
                const LR_Min = new THREE.Vector3(-3.1, -0.2, 4.7);
                const LR_Max = new THREE.Vector3(-1.4, 3.1, 9.4);

                // Right Rudder (Extrapolated)
                // X[1.4, 3.1], Y[-0.2, 3.1], Z[4.7, 9.4]
                const RR_Min = new THREE.Vector3(1.4, -0.2, 4.7);
                const RR_Max = new THREE.Vector3(3.1, 3.1, 9.4);

                const checkBounds = (v, min, max) => {
                    return v.x >= min.x && v.x <= max.x &&
                        v.y >= min.y && v.y <= max.y &&
                        v.z >= min.z && v.z <= max.z;
                };

                const checkNozzle = (x, y, z) => {
                    // Nozzle logic seems to rely on raw coords or scaled? 
                    // The original code used raw coords checking against hardcoded values.
                    // Let's keep nozzle logic as is for now, assuming those constants were tuned similarly.
                    return (z >= NOZZLE_Z_MIN && z <= NOZZLE_Z_MAX) &&
                        (y >= NOZZLE_Y_MIN && y <= NOZZLE_Y_MAX) &&
                        (Math.abs(x) <= NOZZLE_X_ABS);
                };

                const tmpV = new THREE.Vector3();

                // UV Mapping Helpers (Planar Projection)
                const mapU = (val) => (val / 40) + 0.5;
                const mapV = (val) => (val / 90) + 0.5;

                // Rudder Arrays
                const leftRudderPositions = [];
                const leftRudderUVs = [];
                const rightRudderPositions = [];
                const rightRudderUVs = [];

                for (let i = 0; i < count; i += 3) {
                    // Get Triangle Vertices (Raw Local Space)
                    const ax = posAttr.getX(i); const ay = posAttr.getY(i); const az = posAttr.getZ(i);
                    const bx = posAttr.getX(i + 1); const by = posAttr.getY(i + 1); const bz = posAttr.getZ(i + 1);
                    const cx = posAttr.getX(i + 2); const cy = posAttr.getY(i + 2); const cz = posAttr.getZ(i + 2);

                    // 1. Check Nozzles
                    let isNozzle = 0;
                    if (checkNozzle(ax, ay, az)) isNozzle++;
                    if (checkNozzle(bx, by, bz)) isNozzle++;
                    if (checkNozzle(cx, cy, cz)) isNozzle++;

                    if (isNozzle >= 2) {
                        nozzlePositions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
                        continue; // Skip other checks
                    }

                    // 2. Check Stabilizers & Rudders
                    // We must transform to "Debug World Space" to use the user's coordinates
                    let scoreLeftStab = 0;
                    let scoreRightStab = 0;
                    let scoreLeftRudder = 0;
                    let scoreRightRudder = 0;

                    const verts = [new THREE.Vector3(ax, ay, az), new THREE.Vector3(bx, by, bz), new THREE.Vector3(cx, cy, cz)];

                    verts.forEach(v => {
                        tmpV.copy(v).applyMatrix4(debugMatrix); // Transform to match debug tool
                        if (checkBounds(tmpV, LS_Min, LS_Max)) scoreLeftStab++;
                        if (checkBounds(tmpV, RS_Min, RS_Max)) scoreRightStab++;
                        if (checkBounds(tmpV, LR_Min, LR_Max)) scoreLeftRudder++;
                        if (checkBounds(tmpV, RR_Min, RR_Max)) scoreRightRudder++;
                    });

                    // Separate Geometries
                    if (scoreLeftStab >= 3) {
                        leftStabPositions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
                        leftStabUVs.push(mapU(ax), mapV(az), mapU(bx), mapV(bz), mapU(cx), mapV(cz));
                    } else if (scoreRightStab >= 3) {
                        rightStabPositions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
                        rightStabUVs.push(mapU(ax), mapV(az), mapU(bx), mapV(bz), mapU(cx), mapV(cz));
                    } else if (scoreLeftRudder >= 3) {
                        leftRudderPositions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
                        leftRudderUVs.push(mapU(ax), mapV(az), mapU(bx), mapV(bz), mapU(cx), mapV(cz));
                    } else if (scoreRightRudder >= 3) {
                        rightRudderPositions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
                        rightRudderUVs.push(mapU(ax), mapV(az), mapU(bx), mapV(bz), mapU(cx), mapV(cz));
                    } else {
                        // Fuselage
                        fuselagePositions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
                        fuselageUVs.push(mapU(ax), mapV(az), mapU(bx), mapV(bz), mapU(cx), mapV(cz));
                    }
                }

                // --- BUILD MESHES ---

                // 1. Fuselage
                const fuselageGeo = new THREE.BufferGeometry();
                fuselageGeo.setAttribute('position', new THREE.Float32BufferAttribute(fuselagePositions, 3));
                fuselageGeo.setAttribute('uv', new THREE.Float32BufferAttribute(fuselageUVs, 2));
                fuselageGeo.computeVertexNormals();

                // Existing Texture Logic
                const texLoader = new THREE.TextureLoader();
                const texture = texLoader.load(new URL('./assets/skin.png', import.meta.url).href);
                texture.wrapS = THREE.RepeatWrapping;
                texture.wrapT = THREE.RepeatWrapping;
                texture.repeat.set(1, 1);
                const fuselageMat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.6, metalness: 0.3 });

                // Create a container for the body parts
                const bodyGroup = new THREE.Group();

                const fuselageMesh = new THREE.Mesh(fuselageGeo, fuselageMat);
                bodyGroup.add(fuselageMesh);

                // 2. Nozzles
                if (nozzlePositions.length > 0) {
                    const nozzleGeo = new THREE.BufferGeometry();
                    nozzleGeo.setAttribute('position', new THREE.Float32BufferAttribute(nozzlePositions, 3));
                    nozzleGeo.computeVertexNormals();
                    const nozzleMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8, metalness: 0.8 });
                    const nozzleMesh = new THREE.Mesh(nozzleGeo, nozzleMat);
                    nozzleMesh.name = 'nozzle';
                    bodyGroup.add(nozzleMesh);
                }

                // 3. Control Surfaces (Helper Function)
                const createControlSurface = (positions, uvs, name, axis = 'z') => {
                    if (positions.length === 0) return null;
                    const geo = new THREE.BufferGeometry();
                    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
                    geo.computeVertexNormals();

                    // Re-calculate center from positions for Pivot
                    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
                    for (let i = 0; i < positions.length; i += 3) {
                        minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
                        minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
                        minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
                    }
                    const centerX = (minX + maxX) / 2;
                    const centerY = (minY + maxY) / 2;

                    // For Rudders (vertical), hinge is likely at Z max (trailing edge) or min (leading edge)? 
                    // Usually Rudders hinge on a vertical axis. Let's assume hinge is at the "front" (maxZ if Z+ is front? No Z+ is back on this model?)
                    // Model: Nose is -Z (approx), Tail is +Z (approx).
                    // Wait, previous code: `centerZ = maxZ; // Hinge at maxZ (Likely Leading Edge if Z+ is Front)`
                    // If Nose is -Z, then maxZ is the back/tail. Leading edge would be minZ? 
                    // Let's stick to Center for now or verify where Z+ is.
                    // Previous Stabilizer logic used maxZ. Let's try minZ for Rudders if they are vertical fins?
                    // Actually, let's use Center for simplicity unless it looks weird.
                    // Better: Rudders rotate around Y axis (Yaw).
                    // Axis arg added to support different pivot logic if needed.

                    const centerZ = maxZ; // Keeping consistency with stabilizers for now

                    geo.translate(-centerX, -centerY, -centerZ); // Move geometry to origin (Pivot Point)

                    const mat = fuselageMat.clone(); // Use same skin
                    const mesh = new THREE.Mesh(geo, mat);
                    mesh.position.set(centerX, centerY, centerZ); // Move mesh to original spot relative to parent
                    mesh.name = name;
                    return mesh;
                };

                // Create Left Stab
                this.leftStab = createControlSurface(leftStabPositions, leftStabUVs, 'leftStab');
                if (this.leftStab) bodyGroup.add(this.leftStab);

                // Create Right Stab
                this.rightStab = createControlSurface(rightStabPositions, rightStabUVs, 'rightStab');
                if (this.rightStab) bodyGroup.add(this.rightStab);

                // Create Left Rudder
                this.leftRudder = createControlSurface(leftRudderPositions, leftRudderUVs, 'leftRudder');
                if (this.leftRudder) bodyGroup.add(this.leftRudder);

                // Create Right Rudder
                this.rightRudder = createControlSurface(rightRudderPositions, rightRudderUVs, 'rightRudder');
                if (this.rightRudder) bodyGroup.add(this.rightRudder);

                // Apply Transforms to the Body Group (Standard Model Transforms)
                bodyGroup.rotation.x = 0;
                bodyGroup.rotation.y = Math.PI;
                bodyGroup.rotation.z = 0;
                bodyGroup.scale.set(0.25, 0.25, 0.25);

                bodyGroup.traverse((child) => {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;
                    }
                });

                // Add to the existing this.model group (instead of destroying this.mesh)
                this.model.add(bodyGroup);

                console.log("F-18 Split-Mesh Model Loaded with Custom Skin");

                // Auto-apply saved appearance from localStorage
                this.loadSavedAppearance();
            },
            (xhr) => { console.log((xhr.loaded / xhr.total * 100) + '% loaded'); },
            (error) => { console.log('An error happened', error); }
        );
    }
    // ... (rest of methods)

    initNozzles() {
        // User requested removing extra nozzle geometry.
        // We now color vertices in loadModel() instead.
    }

    getKph() {
        // Map 0 to maxSpeed (100.0) -> 0 to 2500 kph
        return Math.floor((this.speed / this.maxSpeed) * 2500);
    }

    update(delta, world, targets = [], oilBottleMesh = null, templeMesh = null, easterEggCube = null) {
        if (this.crashed) return;

        let isYawing = false;

        // Update engine sound based on throttle
        this.updateEngineSound();
        this.updateExhaust();

        // 3. Weapons
        const isFiring = this.manualControl && this.input.isDown('Space');
        if (isFiring) {
            const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.mesh.quaternion);
            // Actual world speed is physically boosted (7.5x instead of 5x) 
            // This is "stealth" speed - not shown on speedometer
            const velocity = forward.multiplyScalar(this.speed * 7.5);
            this.cannon.fire(this.mesh.position, this.mesh.quaternion, velocity);
        } else {
            // Stop boolets audio when not firing
            this.cannon.stopBooletsAudio();
        }

        // --- Pizza Weapon (KeyP) Semi-Auto ---
        if (this.manualControl) {
            const pizzaKey = this.input.isDown('KeyP');
            if (pizzaKey && !this.pizzaKeyWasDown) {
                const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.mesh.quaternion);
                const velocity = forward.multiplyScalar(this.speed * 15.0); // Aircraft's real physical translation speed
                this.pizzaWeapon.fire(this.mesh.position, this.mesh.quaternion, velocity);
            }
            this.pizzaKeyWasDown = pizzaKey;
        }

        // HUD Recoil Effect
        const hud = document.getElementById('combat-hud');
        if (hud) {
            if (isFiring) hud.classList.add('hud-vibrate');
            else hud.classList.remove('hud-vibrate');
        }

        this.cannon.update(delta, world, targets, oilBottleMesh, templeMesh, easterEggCube);
        this.pizzaWeapon.update(delta, world, targets);

        // --- Radar Update ---
        // this.updateRadar(targets); // Disabled: Handled in main.js

        // --- Control Surface Animation ---
        if (this.leftStab && this.rightStab) {
            const maxDeflection = THREE.MathUtils.degToRad(20); // 20 degrees max

            // Inputs
            let pitchInput = 0;
            if (this.manualControl) {
                if (this.input.isDown('KeyW') || this.input.isDown('ArrowUp')) pitchInput = 1;
                else if (this.input.isDown('KeyS') || this.input.isDown('ArrowDown')) pitchInput = -1;
            }

            let rollInput = 0;
            if (this.manualControl) {
                if (this.input.isDown('ArrowLeft') || this.input.isDown('KeyA')) rollInput = 1;
                else if (this.input.isDown('ArrowRight') || this.input.isDown('KeyD')) rollInput = -1;
            }

            const targetLeft = (-pitchInput * 1.0 + rollInput * 1.0) * maxDeflection;
            const targetRight = (-pitchInput * 1.0 - rollInput * 1.0) * maxDeflection;


            // Smooth interpolation
            const smooth = 10 * delta;
            this.leftStab.rotation.x = THREE.MathUtils.lerp(this.leftStab.rotation.x, targetLeft, smooth);
            this.rightStab.rotation.x = THREE.MathUtils.lerp(this.rightStab.rotation.x, targetRight, smooth);
        }

        // --- Rudder Animation ---
        if (this.leftRudder && this.rightRudder) {
            const maxRudderDeflection = THREE.MathUtils.degToRad(5); // Reduced to 5 degrees for extreme subtlety

            let yawInput = 0;
            if (this.input.isDown('KeyA')) yawInput = 1; // Left Yaw
            else if (this.input.isDown('KeyD')) yawInput = -1; // Right Yaw

            // Yaw Left -> Rudder trailing edge RIGHT -> Rotation -Y?
            // Let's assume standard Y axis rotation
            const targetYaw = yawInput * maxRudderDeflection;

            // Smooth interpolation
            const smooth = 10 * delta;

            // Both rudders move together
            // If Pivot is center, rotation Y should work.
            // CAUTION: 'KeyA' is also Roll Left in some logic above?
            // "if (this.input.isDown('ArrowLeft') || this.input.isDown('KeyA')) rollInput = 1;"
            // Yes, A/D is mapping to BOTH Roll and Yaw currently?
            // Let's check the Input handling below.
            // "if (this.input.isDown('KeyA')) { this.mesh.rotateY(yawRate * delta); }"
            // "if (this.input.isDown('ArrowLeft') || this.input.isDown('KeyA')) rollInput = 1;"
            // It seems A/D does both Yaw and Roll in this arcade sim.

            this.leftRudder.rotation.y = THREE.MathUtils.lerp(this.leftRudder.rotation.y, targetYaw, smooth);
            this.rightRudder.rotation.y = THREE.MathUtils.lerp(this.rightRudder.rotation.y, targetYaw, smooth);
        }

        // Control Surface Rates
        const pitchRate = 1.0;
        const rollRate = 1.5;
        const yawRate = 0.5;

        // 1. Controls (Local Space)
        if (this.manualControl) {
            // Pitch: W/Up (Down/Push) vs S/Down (Up/Pull)
            if (this.input.isDown('ArrowUp') || this.input.isDown('KeyW')) {
                this.mesh.rotateX(-pitchRate * delta); // Push forward -> Pitch Down
            }
            if (this.input.isDown('ArrowDown') || this.input.isDown('KeyS')) {
                this.mesh.rotateX(pitchRate * delta); // Pull back -> Pitch Up
            }

            // Roll (Increased for snappier turns)
            if (this.input.isDown('ArrowLeft')) {
                this.mesh.rotateZ(rollRate * 1.5 * delta);
            }
            if (this.input.isDown('ArrowRight')) {
                this.mesh.rotateZ(-rollRate * 1.5 * delta);
            }

            // Yaw
            if (this.input.isDown('KeyA')) {
                this.mesh.rotateY(yawRate * delta);
                isYawing = true;
            }
            if (this.input.isDown('KeyD')) {
                this.mesh.rotateY(-yawRate * delta);
                isYawing = true;
            }

            // Throttle Control
            const throttleRate = 0.5;
            if (this.input.isDown('ShiftLeft') || this.input.isDown('ShiftRight')) {
                this.throttle = Math.min(this.throttle + throttleRate * delta, 1.0);
            } else if (this.input.isDown('ControlLeft') || this.input.isDown('ControlRight')) {
                this.throttle = Math.max(this.throttle - throttleRate * delta, 0.0);
            }
        }

        // 2. Physics & Aerodynamics

        // Thrust (Recalibrated for exponential top speed when maxed out)
        // If throttle > 0.9 (afterburner), we apply a massive thrust multiplier
        let currentThrust = this.throttle * 130.0;
        if (this.throttle > 0.9) {
            currentThrust *= 2.5; // Massive afterburner kick for top speed
        }

        const thrust = currentThrust;

        // Drag
        // Base drag (0.0125 * 100^2 = 125 drag at max speed)
        const baseDrag = (this.speed * this.speed) * 0.0125;

        // Induced drag (approximated)
        let inducedDrag = 0;
        // Pitching up (Turning hard) creates drag
        if (this.input.isDown('ArrowDown') || this.input.isDown('KeyS')) {
            inducedDrag += (this.speed * this.speed) * this.inducedDragFactor;
        }
        // Yawing (Sideslip) creates drag
        if (isYawing) {
            inducedDrag += (this.speed * this.speed) * this.inducedDragFactor * 0.5;
        }

        const totalDrag = baseDrag + inducedDrag;

        // Acceleration
        const accel = thrust - totalDrag;

        // Update Speed
        this.speed += accel * delta;

        // Soft Limits
        this.speed = Math.max(0, this.speed);

        // Gravity influence on speed (climbing slows down, diving speeds up)
        const forward = new THREE.Vector3(0, 0, -1);
        forward.applyQuaternion(this.mesh.quaternion);

        // If forward.y is positive (climbing), gravity acts against speed.
        this.speed -= forward.y * delta * 0.5;

        // Supersonic Translation: Reverted back to 15x multiplier
        this.mesh.translateZ(-this.speed * delta * 15.0);

        // Ceiling Clamp for Player Aircraft (60,000 feet)
        if (this.mesh.position.y > 15000) {
            this.mesh.position.y = 15000;
        }

        // Sync position
        this.position.copy(this.mesh.position);

        // Animate propeller (if it existed) or other parts
        // No propeller on F-16

        // Collision Detection
        if (world) {
            const terrainHeight = world.getHeightAt(this.position.x, this.position.z);
            if (this.position.y <= terrainHeight + 1) {
                this.crash();
            }
        }

        // Oil Bottle Reload
        if (oilBottleMesh && oilBottleMesh.visible && this.mesh) {
            // Use Bounding Box intersection to reliably detect the giant oil bottle
            const playerBox = new THREE.Box3().setFromObject(this.mesh);
            const oilBox = new THREE.Box3().setFromObject(oilBottleMesh);

            // Use exact bounding box intersections for tight collision
            // No extra padding; you must fly right up to or through the bottle.

            if (playerBox.intersectsBox(oilBox)) {
                if (this.cannon.ammo < this.cannon.maxAmmo) {
                    this.cannon.reload();
                    console.log('RELOADED VIA BOTTLE!');

                    // Visual feedback
                    const hud = document.getElementById('combat-hud');
                    if (hud) {
                        hud.style.filter = 'drop-shadow(0 0 20px #0f0)';
                        setTimeout(() => hud.style.filter = 'drop-shadow(0 0 4px #00ffff)', 200);
                    }
                }
            }
        }
    }

    initExhaust() {
        console.log("initExhaust START");
        // alert("Initializing Exhaust!"); 

        // Initialize Nozzle Shrouds (Black Collars)
        this.initNozzles();

        // Create exhaust geometry
        // F-18 has two engines. We need two cones.
        const geometry = new THREE.ConeGeometry(0.15, 3, 64); // Radius (halved), Height, Segments (increased for smoothness)
        geometry.translate(0, 1.5, 0); // Shift pivot to BASE. Cone is Y-up. Base at -1.5 -> 0. Tip at 1.5 -> 3.
        geometry.rotateX(Math.PI / 2); // Rotate +Y (up) to +Z (back). 

        // Generate Shock Diamond Texture
        const texture = this.generateExhaustTexture();

        // Emissive material for glow with texture
        const material = new THREE.MeshBasicMaterial({
            color: 0xffaa00, // Orange tint
            map: texture,
            transparent: true,
            opacity: 1.0, // Start fully opaque
            side: THREE.DoubleSide,
            depthWrite: false,
            // blending: THREE.AdditiveBlending // REMOVED: Makes it too transparent against sky
        });

        // Left Engine Exhaust
        // Coords from Debug Session: X: 0.60, Y: -1.60, Z: 10.60, Scale: 1.30
        this.exhaustLeft = new THREE.Mesh(geometry, material.clone());
        this.exhaustLeft.position.set(-0.60, -1.60, 10.60);
        this.exhaustLeft.name = 'exhaust';
        this.model.add(this.exhaustLeft);

        // Right Engine Exhaust
        this.exhaustRight = new THREE.Mesh(geometry, material.clone());
        this.exhaustRight.position.set(0.60, -1.60, 10.60);
        this.exhaustRight.name = 'exhaust';
        this.model.add(this.exhaustRight);

        // Apply visual scale
        this.exhaustBaseScale = 1.30;

        // Hide initially until engine starts? Or just smoulder.
        this.updateExhaustMesh(this.exhaustLeft, 0);
        this.updateExhaustMesh(this.exhaustRight, 0);
    }

    updateExhaustMesh(mesh, throttleRatio) {
        if (!mesh) return;

        const isAfterburner = throttleRatio > 0.99; // 100% throttle

        const color = new THREE.Color();
        const baseScale = (this.exhaustScaleMult || 1.0) * (this.exhaustBaseScale || 1.0);

        // FLAME PHYSICS (Orange Edition):
        // Low Throttle: Dull Red/Orange
        // High Throttle: Bright Yellow/Orange
        // Afterburner: Blinding White-Yellow

        if (isAfterburner) {
            // AFTERBURNER: Blinding White-Yellow
            color.setHex(0xffddaa); // White-Orange
            mesh.material.color.copy(color);

            mesh.material.opacity = 1.0; // Fully Opaque

            // Long, distinct, vibrating
            mesh.scale.set(1.4 * baseScale, (4.5 + Math.random() * 0.5) * baseScale, 1.4 * baseScale);

            // Fast Jitter
            if (mesh.material.map) mesh.material.map.offset.y -= 0.08;

        } else if (throttleRatio > 0.3) {
            // CRUISE / POWER: Bright Orange
            // Interp from Red-Orange (0xff3300) to Yellow-Orange (0xffaa00)
            color.lerpColors(new THREE.Color(0xff3300), new THREE.Color(0xffaa00), (throttleRatio - 0.3) / 0.7);
            mesh.material.color.copy(color);

            mesh.material.opacity = 1.0; // Fully Opaque

            // Scale grows with throttle
            const len = 1.5 + (throttleRatio * 1.5); // 1.5 to 3.0
            mesh.scale.set(baseScale, len * baseScale, baseScale);

            // Medium Jitter
            if (mesh.material.map) mesh.material.map.offset.y -= 0.03;

        } else {
            // IDLE: Dismal Red
            color.setHex(0xff0000); // Pure Red
            mesh.material.color.copy(color);

            // Pulse
            const pulse = 0.9 + (Math.sin(Date.now() * 0.005) * 0.1);
            mesh.material.opacity = 0.8 * pulse; // Higher idle opacity

            mesh.scale.set(0.8 * baseScale, 0.8 * baseScale, 0.8 * baseScale); // Short

            // Slow flow
            if (mesh.material.map) mesh.material.map.offset.y -= 0.005;
        }
    }

    updateExhaust() {
        if (this.exhaustLeft) this.updateExhaustMesh(this.exhaustLeft, this.throttle);
        if (this.exhaustRight) this.updateExhaustMesh(this.exhaustRight, this.throttle);
    }

    crash() {
        this.crashed = true;
        this.speed = 0;

        // Hide exhaust on crash
        if (this.exhaustLeft) this.exhaustLeft.visible = false;
        if (this.exhaustRight) this.exhaustRight.visible = false;

        // Stop engine sound
        if (this.engineSound) {
            this.engineSound.pause();
            this.engineSound.currentTime = 0;
        }

        // Play crash sound
        if (this.crashSound) {
            this.crashSound.play().catch(e => console.log('Crash sound play failed:', e));
        }

        console.log("CRASHED!");
        document.dispatchEvent(new Event('gameover'));
    }

    generateExhaustTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');

        // Gradient for the main flame body (White core to Yellow/Orange/Red edge is handled by material color)
        // We need ALPHA gradient for shape and LIGHTNESS for diamonds.

        // 1. Base Alpha Gradient
        const gradient = ctx.createLinearGradient(0, 0, 0, 256);
        gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
        gradient.addColorStop(0.6, 'rgba(255, 255, 255, 1)'); // Solid for 60% of length
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 64, 256);

        // 2. Blowtorch Core
        const coreGrad = ctx.createLinearGradient(0, 0, 64, 0);
        coreGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
        coreGrad.addColorStop(0.3, 'rgba(255, 255, 255, 0.8)'); // Wider solid core
        coreGrad.addColorStop(0.5, 'rgba(255, 255, 255, 1)');
        coreGrad.addColorStop(0.7, 'rgba(255, 255, 255, 0.8)');
        coreGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

        ctx.fillStyle = coreGrad;
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillRect(0, 0, 64, 256);

        // 3. Shock Diamonds
        const diamondCount = 6; // More diamonds for higher pressure feel
        const spacing = 256 / diamondCount;

        for (let i = 1; i < diamondCount; i++) {
            const y = i * spacing;

            // Harder, brighter diamonds for blowtorch look
            const diamondGrad = ctx.createRadialGradient(32, y, 0, 32, y, 25);
            diamondGrad.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
            diamondGrad.addColorStop(0.4, 'rgba(255, 255, 255, 0.4)');
            diamondGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

            ctx.fillStyle = diamondGrad;
            ctx.fillRect(0, y - 25, 64, 50);
        }

        const texture = new THREE.CanvasTexture(canvas);
        return texture;
    }

    updateRadar(targets) {
        const blipContainer = document.getElementById('radar-blips');
        if (!blipContainer) return;
        blipContainer.innerHTML = ''; // Clear old blips

        const radarRadius = 70; // 140px / 2
        const maxDetectionRange = 10000;

        // Heading Up Radar: We need to rotate the world relative to aircraft Y rotation
        const playerRotY = this.mesh.rotation.y;

        targets.forEach(t => {
            if (t.isDestroyed || !t.mesh) return;

            // Relative position in world space
            const dx = t.mesh.position.x - this.mesh.position.x;
            const dz = t.mesh.position.z - this.mesh.position.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist < maxDetectionRange) {
                // Transform to local space (Heading Up)
                // angle is -playerRotY to align forward to +Z(up on radar)
                const angle = -playerRotY;
                const localX = dx * Math.cos(angle) - dz * Math.sin(angle);
                const localZ = dx * Math.sin(angle) + dz * Math.cos(angle);

                // Map to radar units (-radarRadius to radarRadius)
                const rx = (localX / maxDetectionRange) * radarRadius;
                const rz = (localZ / maxDetectionRange) * radarRadius;

                // Create Blip
                const blip = document.createElement('div');
                blip.className = 'radar-blip';
                if (t.isAirship) blip.classList.add('airship');

                // Position in UI (50% is center)
                // Radar Y axis is inverted (up is -Z in local space)
                blip.style.left = (50 + (rx / radarRadius) * 50) + '%';
                blip.style.top = (50 - (rz / radarRadius) * 50) + '%';

                blipContainer.appendChild(blip);
            }
        });
    }

    initNozzles() {
        // User requested removing extra nozzle geometry.
        // We now color vertices in loadModel() instead.
    }

    // --- APPEARANCE CUSTOMIZATION ---

    applySkin(dataURL) {
        if (!this.model) return;
        const img = new Image();
        img.src = dataURL;
        img.onload = () => {
            const texture = new THREE.Texture(img);
            texture.needsUpdate = true;
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;

            this.model.traverse((child) => {
                if (child.isMesh) {
                    if (child.name === 'nozzle' || child.name === 'exhaust') return;
                    if (child.geometry.type === 'DecalGeometry') return;
                    if (child.material) {
                        if (Array.isArray(child.material)) {
                            child.material.forEach(m => {
                                m.map = texture;
                                m.color.setHex(0xffffff);
                                m.needsUpdate = true;
                            });
                        } else {
                            child.material.map = texture;
                            child.material.color.setHex(0xffffff);
                            child.material.needsUpdate = true;
                        }
                    }
                }
            });
            console.log("Aircraft skin applied!");
        };
    }

    applyColor(hexColor) {
        if (!this.model) return;
        const color = new THREE.Color(hexColor);
        this.model.traverse((child) => {
            if (child.isMesh) {
                if (child.name === 'nozzle' || child.name === 'exhaust') return;
                if (child.geometry.type === 'DecalGeometry') return;
                if (child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach(m => {
                            m.map = null;
                            m.color.copy(color);
                            m.needsUpdate = true;
                        });
                    } else {
                        child.material.map = null;
                        child.material.color.copy(color);
                        child.material.needsUpdate = true;
                    }
                }
            }
        });
        console.log("Aircraft color applied:", hexColor);
    }

    resetSkin() {
        if (!this.model) return;

        const textureLoader = new THREE.TextureLoader();
        const texture = textureLoader.load(new URL('./assets/skin.png', import.meta.url).href);
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(1, 1);

        this.model.traverse((child) => {
            if (child.isMesh) {
                if (child.name === 'nozzle' || child.name === 'exhaust') return;
                if (child.geometry.type === 'DecalGeometry') return; // protect decals
                if (child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach(m => {
                            m.map = texture;
                            m.color.setHex(0xffffff);
                            m.needsUpdate = true;
                        });
                    } else {
                        child.material.map = texture;
                        child.material.color.setHex(0xffffff);
                        child.material.needsUpdate = true;
                    }
                }
            }
        });
        console.log("Aircraft appearance reset to default skin.png.");
    }

    loadSavedAppearance() {
        try {
            const saved = localStorage.getItem('aircraftAppearance');
            if (!saved) return;
            const config = JSON.parse(saved);
            if (config.type === 'skin' && config.dataURL) {
                this.applySkin(config.dataURL);
            } else if (config.type === 'color' && config.hex) {
                this.applyColor(config.hex);
            }
            console.log("Loaded saved appearance:", config.type);
        } catch (e) {
            console.warn("Failed to load saved appearance:", e);
        }
    }
}
