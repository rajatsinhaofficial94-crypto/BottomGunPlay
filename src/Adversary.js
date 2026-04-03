import * as THREE from 'three';
import { GLTFLoader } from './lib/GLTFLoader.js';

export class Adversary {
    // Reusable math objects to prevent GC
    static _tempVec = new THREE.Vector3();
    static _tempVec2 = new THREE.Vector3();
    static _tempVec3 = new THREE.Vector3();
    static _tempQuat = new THREE.Quaternion();
    static _tempMat = new THREE.Matrix4();
    static _UP = new THREE.Vector3(0, 1, 0);

    constructor(scene, input, options = {}) {
        this.scene = scene;
        this.input = input;

        const {
            startPosition = new THREE.Vector3(0, 600, -150)
        } = options;

        this.position = startPosition.clone();
        this.velocity = new THREE.Vector3(0, 0, -1);
        this.speed = 25.0;
        this.maxSpeed = 50.0;
        this.throttle = 0.5;
        this.acceleration = 0;
        this.dragCoefficient = 0.5;
        this.inducedDragFactor = 0.1;
        this.manualControl = false;
        this.cameraScale = 10.0; // Giant scale for camera offsets

        this.isLoaded = false;
        this.health = 100;
        this.isDestroyed = false;

        // --- AI Diversity ---
        this.isAirship = options.isAirship || false;
        this.health = this.isAirship ? 5 : 1;

        this.seed = options.seed || Math.random();
        this.aiParams = {
            steerRate: this.isAirship ? 0.3 : (0.15 + (this.seed * 0.2)),
            // Giants: Aggressive predators that charge the player
            // Regulars: 45.5 - 84.5 (30% Increased Aggression)
            speedMult: this.isAirship ? 48.0 : (45.5 + (this.seed * 39.0)),
            heightPref: this.isAirship ? 600 : (400 + (this.seed * 800)),
            jitter: this.isAirship ? 0.0 : (0.02 + (this.seed * 0.08)),
            jitterSpeed: this.isAirship ? 0.0 : (0.2 + (this.seed * 0.8)),
            // Offset for "Head-On" intercepts to avoid direct collision (Regulars only)
            // Offset for "Head-On" intercepts to avoid direct collision (Regulars only)
            flyByOffset: new THREE.Vector3(
                (Math.random() - 0.5) * 1200,
                (Math.random() - 0.5) * 400,
                (Math.random() - 0.5) * 400
            )
        };
        this.speed = this.aiParams.speedMult;

        // Hit detection: Giants require direct hits, smalls use proximity fuse
        this.hitRadius = this.isAirship ? 30 : 200;

        // The world group for the adversary
        this.mesh = new THREE.Group();
        this.mesh.position.copy(this.position);
        this.scene.add(this.mesh);

        this.scene.add(this.mesh);

        // State for visuals
        this.model = null;
        this.baseCenter = new THREE.Vector3();

        this.loadModel();
        this.muteDeathSound = false; // New: allow silencing death scream
    }

    loadModel() {
        if (this.isLoaded) return;
        const loader = new GLTFLoader();
        loader.load('./src/assets/dono.glb', (gltf) => {
            const model = gltf.scene;
            this.model = model;

            // 0. Sanitize & Get Base Properties
            model.position.set(0, 0, 0);
            model.rotation.set(0, 0, 0);
            // The original model.scale.set(1,1,1) is implicitly handled by the new scaling logic
            // as it operates on the model directly after loading.
            model.updateMatrixWorld(true);

            // --- Mega-Scaling (900 units / Airship 9600 units) ---
            // User requested 3x size increase for Regulars (Was 300 -> Now 900)
            const baseScale = this.isAirship ? 9600 : 900;
            const box = new THREE.Box3().setFromObject(this.model);
            const size = new THREE.Vector3();
            box.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z);
            const scale = baseScale / maxDim;
            this.model.scale.set(scale, scale, scale);
            console.log(`Adversary Loaded: ${this.isAirship ? 'AIRSHIP' : 'REGULAR'}, scale=${baseScale}`);
            this.maxDim = maxDim;
            this.baseScale = baseScale; // Store for collision

            if (this.isAirship) {
                // 1. Giant-on-Giant rigid separation Box (Large)
                this.localHitBox_Giant = new THREE.Box3(
                    new THREE.Vector3(-4100, -3000, -6500),
                    new THREE.Vector3(4100, 3000, 3900) // Z max corrected from user input here
                );

                // 2. Player-on-Giant Hitbox (Smaller, for damage and ramming)
                this.localHitBox_Player = new THREE.Box3(
                    new THREE.Vector3(-2050, -800, -6050),
                    new THREE.Vector3(2050, 1000, 3550)
                );

                // Helper for global AABB collision checking
                this.worldHitBox_Giant = new THREE.Box3();
            }

            this.collisionRadius = (this.isAirship ? 0.2 : 0.6) * baseScale; // Giants: tighter collision for physical contact only
            this.hitRadius = (this.isAirship ? 0.8 : 0.2) * baseScale;       // Bullet hit radius (Small: 0.2, Giant: 0.8)
            this.cameraScale = this.isAirship ? 16.0 : 60.0; // 60.0 for Regulars (Scale 900) to see model

            // Re-calculate center after scaling but AT IDENTITY ROTATION
            this.model.updateMatrixWorld(true); // Update after scaling
            const box3 = new THREE.Box3().setFromObject(this.model); // Use this.model for consistency
            box3.getCenter(this.baseCenter);

            // 2. Initial Setup - Configuration Split
            const regularConfig = {
                // Hardcoded configurations for perfectly aligned small adversaries
                posX: -18, posY: 3, posZ: 0,
                boundNegX: -46, boundPosX: 82,
                boundNegY: -15, boundPosY: 29,
                boundNegZ: -39, boundPosZ: 101,
                paintColor: '#ff0000',
                rotX: 0, rotY: 0, rotZ: 0,
                offX: -25, offY: -12, offZ: 0
            };
            console.log("Regular Config Reset to 0,0,0");

            const giantConfig = {
                // Zero/Center defaults for Scale 9600 (Giants)
                offX: -2600, offY: -1000, offZ: 1300,
                rotX: 0, rotY: 0, rotZ: 0,
                posX: 0, posY: 0, posZ: 0,
                sizeX: 100, sizeY: 100, sizeZ: 100,
                paintColor: '#ffff00'
            };

            // Select based on type
            const factoryConfig = this.isAirship ? giantConfig : regularConfig;

            let config = { ...factoryConfig };

            // Only allow external config override for Regulars (Giants are procedural/fixed)
            // (Removed localStorage override for production readiness)

            // 3. Add Model to World Group
            this.mesh.add(model);

            // Enable Shadows
            model.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                }
            });

            // 4. Initial Sync (Must happen after adding to group for correct coordinates)
            this.syncWithConfig(config);


            // Removed Live Tool Sync Event Listener

            this.isLoaded = true;
            console.log("Adversary: Model Loaded and Synced");
        });
    }

    /**
     * Updates placement and paint based on config without re-loading GLB.
     */
    syncWithConfig(config) {
        if (!this.model) return;
        const model = this.model;

        // SCALING FIX: Tool is 150 units. Game is 300 (Regulars).
        // For Regulars: 300 / 150 = 2.0
        const configScale = this.isAirship ? 1.0 : (this.baseScale / 150.0);

        // --- 1. Alignment (Positioning relative to center) ---
        const ox = (config ? (config.offX || 0) : 0) * configScale;
        const oy = (config ? (config.offY || 0) : 0) * configScale;
        const oz = (config ? (config.offZ || 0) : 0) * configScale;

        // Apply offsets relative to the SANITIZED center
        model.position.set(
            -this.baseCenter.x + ox,
            -this.baseCenter.y + oy,
            -this.baseCenter.z + oz
        );

        // --- 2. Orientation ---
        const rx = config ? THREE.MathUtils.degToRad(config.rotX || 0) : 0;
        const ry = config ? THREE.MathUtils.degToRad(config.rotY || 0) : 0;
        const rz = config ? THREE.MathUtils.degToRad(config.rotZ || 0) : 0;

        // Base orientation correction
        if (!this.isAirship) {
            // MATCH PAINT TOOL EXACTLY: (PI + rx, -PI/2 + ry, rz)
            model.rotation.set(Math.PI + rx, -Math.PI / 2 + ry, rz);
        } else {
            // Keep Giant Logic (Scale 9600)
            const baseRotY = Math.PI / 2;
            model.rotation.set(rx, baseRotY + ry, Math.PI + rz);
        }

        model.updateMatrixWorld(true);

        // --- 3. Paint ---
        this.applyPaint(model, config, configScale);
    }

    applyPaint(model, config, configScale = 1.0) {
        // --- Cleanup old layers ---
        const toRemove = [];
        model.traverse(c => {
            if (c.name === 'paintOverlay') toRemove.push(c);
        });
        toRemove.forEach(c => c.parent.remove(c));

        if (!config) return;

        // --- Extract config ---
        // Apply Scaling Factor to ALL dimensions/positions
        const px = (config.posX !== undefined ? config.posX : 0) * configScale;
        const py = (config.posY !== undefined ? config.posY : 0) * configScale;
        const pz = (config.posZ !== undefined ? config.posZ : 0) * configScale;
        const paintColor = config.paintColor || 0xff0000;

        const box = new THREE.Box3();

        if (config.boundNegX !== undefined) {
            // New Dual-Axis Format v3
            const minX = px + config.boundNegX * configScale;
            const maxX = px + config.boundPosX * configScale;
            const minY = py + config.boundNegY * configScale;
            const maxY = py + config.boundPosY * configScale;
            const minZ = pz + config.boundNegZ * configScale;
            const maxZ = pz + config.boundPosZ * configScale;

            box.set(
                new THREE.Vector3(Math.min(minX, maxX), Math.min(minY, maxY), Math.min(minZ, maxZ)),
                new THREE.Vector3(Math.max(minX, maxX), Math.max(minY, maxY), Math.max(minZ, maxZ))
            );
        } else {
            // Legacy v2 Format Fallback
            const sx = (config.sizeX !== undefined ? config.sizeX : 120) * configScale;
            const sy = (config.sizeY !== undefined ? config.sizeY : 30) * configScale;
            const sz = (config.sizeZ !== undefined ? config.sizeZ : 120) * configScale;
            box.setFromCenterAndSize(new THREE.Vector3(px, py, pz), new THREE.Vector3(sx, sy, sz));
        }

        // DEBUG: Visual Paint Box REMOVED

        const vertices = [];
        model.updateMatrixWorld(true);
        // We need coordinates relative to this.mesh (Group Space)
        // because the tool's config is relative to its scene origin.
        const meshInvMatrix = new THREE.Matrix4().copy(this.mesh.matrixWorld).invert();

        model.traverse(child => {
            if (child.isMesh && child.name !== 'paintOverlay') {
                child.updateMatrixWorld(true);
                // Child-Local to Group Space transform
                const toGroupMatrix = new THREE.Matrix4().multiplyMatrices(meshInvMatrix, child.matrixWorld);

                const geometry = child.geometry;
                const pos = geometry.attributes.position;
                const index = geometry.index;
                const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();

                const checkTriangle = (a, b, c) => {
                    vA.fromBufferAttribute(pos, a).applyMatrix4(toGroupMatrix);
                    vB.fromBufferAttribute(pos, b).applyMatrix4(toGroupMatrix);
                    vC.fromBufferAttribute(pos, c).applyMatrix4(toGroupMatrix);

                    if (box.containsPoint(vA) && box.containsPoint(vB) && box.containsPoint(vC)) {
                        vertices.push(vA.x, vA.y, vA.z, vB.x, vB.y, vB.z, vC.x, vC.y, vC.z);
                    }
                };

                if (index) {
                    for (let i = 0; i < index.count; i += 3) {
                        checkTriangle(index.getX(i), index.getX(i + 1), index.getX(i + 2));
                    }
                } else {
                    for (let i = 0; i < pos.count; i += 3) {
                        checkTriangle(i, i + 1, i + 2);
                    }
                }
            }
        });

        if (vertices.length > 0) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
            geometry.computeVertexNormals();

            const material = new THREE.MeshStandardMaterial({
                color: paintColor,
                side: THREE.DoubleSide,
                polygonOffset: true,
                polygonOffsetFactor: -1,
                polygonOffsetUnits: -4,
                roughness: 0.8
            });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = 'paintOverlay';

            // Transform back to Model-Local space for final attachment
            const invModelMatrix = new THREE.Matrix4().copy(model.matrixWorld).invert();
            const groupToModelMatrix = new THREE.Matrix4().multiplyMatrices(invModelMatrix, this.mesh.matrixWorld);
            geometry.applyMatrix4(groupToModelMatrix);

            console.log(`Adversary Paint: Applied ${vertices.length / 9} triangles.`);
            model.add(mesh);
        } else {
            console.warn("Adversary Paint: No triangles found in selection box!");
        }
    }

    getKph() {
        // Match player scaling: Map speed to 2500 KPH
        // Adversary AI speed is usually around 50-100 range logically? No, it's lower.
        // Let's use speed * 40.
        return Math.floor(this.speed * 40);
    }

    update(delta, world, player = null, templeMesh = null) {
        if (this.isDestroyed) return;

        if (this.manualControl && this.input) {
            // Player-like flight physics ported for testing/manual control
            const pitchRate = 1.0;
            const rollRate = 1.5;
            const yawRate = 0.5;

            if (this.input.isDown('ArrowUp') || this.input.isDown('KeyW')) this.mesh.rotateX(-pitchRate * delta);
            if (this.input.isDown('ArrowDown') || this.input.isDown('KeyS')) this.mesh.rotateX(pitchRate * delta);
            if (this.input.isDown('ArrowLeft')) this.mesh.rotateZ(rollRate * 1.5 * delta);
            if (this.input.isDown('ArrowRight')) this.mesh.rotateZ(-rollRate * 1.5 * delta);

            let isYawing = false;
            if (this.input.isDown('KeyA')) { this.mesh.rotateY(yawRate * delta); isYawing = true; }
            if (this.input.isDown('KeyD')) { this.mesh.rotateY(-yawRate * delta); isYawing = true; }

            const throttleRate = 0.5;
            if (this.input.isDown('ShiftLeft') || this.input.isDown('ShiftRight')) this.throttle = Math.min(this.throttle + throttleRate * delta, 1.0);
            else if (this.input.isDown('ControlLeft') || this.input.isDown('ControlRight')) this.throttle = Math.max(this.throttle - throttleRate * delta, 0.0);

            const thrust = this.throttle * 32.0;
            const baseDrag = (this.speed * this.speed) * 0.0125;
            let inducedDrag = 0;
            if (this.input.isDown('ArrowDown') || this.input.isDown('KeyS')) inducedDrag += (this.speed * this.speed) * this.inducedDragFactor;
            if (isYawing) inducedDrag += (this.speed * this.speed) * this.inducedDragFactor * 0.5;

            const totalDrag = baseDrag + inducedDrag;
            const accel = thrust - totalDrag;
            this.speed += accel * delta;
            this.speed = Math.max(0, this.speed);

            const forward = new THREE.Vector3(0, 0, -1);
            forward.applyQuaternion(this.mesh.quaternion);
            this.speed -= forward.y * delta * 0.5;

            this.mesh.translateZ(-this.speed * delta * 5);
        } else {
            // --- AI MODE (Physics-Based Flight) ---

            if (!this.isAirship) {
                // --- REGULAR ADVERSARY (Physics) ---

                // 1. Initialize Vectors if missing
                if (!this.velocity) this.velocity = new THREE.Vector3(0, 0, 1).applyQuaternion(this.mesh.quaternion).multiplyScalar(this.speed);
                if (!this.acceleration) this.acceleration = new THREE.Vector3();

                const maxSpeed = this.aiParams.speedMult * 15.0; // Restored to 15.0

                // TURN RATE RESTORED: Back to 25.0 as requested
                // This makes them aggressive and sharp again
                // TURN RATE INCREASED: 35.0 (Aggressive)
                const maxForce = 35.0;

                // 2. Determine Target (Player or Patrol)
                // Use reused vector
                Adversary._tempVec.set(0, 0, 0);

                if (player && player.mesh && !player.crashed) {
                    Adversary._tempVec.copy(player.mesh.position);

                    // Leading the target (Predictive aiming - Randomized per aircraft)
                    const distToPlayer = this.mesh.position.distanceTo(player.mesh.position);
                    const lookAhead = distToPlayer * (0.05 + (this.seed * 0.1)); // 0.05x to 0.15x lead distance

                    // Reused vector calculation
                    Adversary._tempVec2.set(0, 0, -player.speed).applyQuaternion(player.mesh.quaternion).multiplyScalar(lookAhead);
                    Adversary._tempVec.add(Adversary._tempVec2);

                    // ENCIRCLEMENT BEHAVIOR (Orbit vs Pursuit)
                    let blendFactor = 0; // 0 = Pursuit, 1 = Orbit
                    if (distToPlayer < 5000) {
                        blendFactor = 1.0;
                    } else if (distToPlayer < 15000) {
                        blendFactor = (15000 - distToPlayer) / 10000;
                    }

                    if (blendFactor > 0) {
                        const time = Date.now() * 0.0005; // Critical: Slower time ensures smoother orbits
                        const orbitRadius = 1000 + (this.seed * 1000); // 1000 to 2000 radius per plane

                        // Calculated orbital position based on seed
                        const angle = (time * (0.5 + this.seed)) + (this.seed * Math.PI * 2);
                        const elevation = Math.sin(time * 0.3 + this.seed * 10) * 1000;

                        // Use temp vector for orbit offset
                        Adversary._tempVec3.set(
                            Math.cos(angle) * orbitRadius,
                            elevation,
                            Math.sin(angle) * orbitRadius
                        );

                        // Orbital Pos = Target + Offset
                        Adversary._tempVec2.copy(Adversary._tempVec).add(Adversary._tempVec3);

                        // Lerp result back into targetPos (held in _tempVec)
                        Adversary._tempVec.lerp(Adversary._tempVec2, blendFactor);
                    }

                } else {
                    // Patrol pattern if no player
                    const time = Date.now() * 0.0001 + this.seed;
                    Adversary._tempVec.set(
                        Math.sin(time) * 5000,
                        2000 + Math.cos(time * 0.7) * 500,
                        Math.cos(time) * 5000
                    );
                }

                // 3. Ground Avoidance & Minimum Altitude (Priority 1)
                let terrainHeight = world ? world.getHeightAt(this.mesh.position.x, this.mesh.position.z) : 0;
                let hardDeck = terrainHeight + 600; // Warning threshold
                if (!this.isAirship && hardDeck < 1000) {
                    hardDeck = 1000; // Minimum altitude floor for small adversaries
                }

                if (this.mesh.position.y < hardDeck) {
                    // If diving too low, blend current target smoothly UPWARD
                    const severity = (hardDeck - this.mesh.position.y) / 600; // 0.0 to 1.0 (or higher if plunged deep)

                    // Keep the current horizontal target, but massively inflate the Y target based on how close to dirt they are
                    Adversary._tempVec.y += (3000 * severity);
                }

                // 4. ARCADE PHYSICS (Direct Steering)

                // PREVENT GIMBAL LOCK: If target is almost perfectly above or below us, THREE.js lookAt flips out.
                // We add a slight horizontal nudge in our current forward direction to prevent the math breaking.
                const dx = Adversary._tempVec.x - this.mesh.position.x;
                const dz = Adversary._tempVec.z - this.mesh.position.z;
                if ((dx * dx + dz * dz) < 1.0) {
                    const currentFwd = Adversary._tempVec3.set(0, 0, -1).applyQuaternion(this.mesh.quaternion);
                    if (Math.abs(currentFwd.x) < 0.01 && Math.abs(currentFwd.z) < 0.01) {
                        currentFwd.set(0, 0, -1); // Fallback horizontal momentum
                    }
                    Adversary._tempVec.x += currentFwd.x * 100.0;
                    Adversary._tempVec.z += currentFwd.z * 100.0;
                }

                // Calculate desired rotation to face target
                const m1 = Adversary._tempMat;
                m1.lookAt(Adversary._tempVec, this.mesh.position, Adversary._UP);

                const targetQuaternion = Adversary._tempQuat;
                targetQuaternion.setFromRotationMatrix(m1);

                // Rotate towards target (Turn Rate varies slightly per plane)
                const turnRate = (2.5 + (this.seed * 1.5)) * delta; // 2.5 to 4.0 radians per second
                this.mesh.quaternion.slerp(targetQuaternion, turnRate);

                // 5. Move Forward
                // Fly exactly where we are looking (No drift)
                // Fix: -1 is Forward in this engine's local space
                const forward = Adversary._tempVec3.set(0, 0, -1).applyQuaternion(this.mesh.quaternion);
                this.velocity.copy(forward).multiplyScalar(maxSpeed);
                this.mesh.position.add(this.velocity.clone().multiplyScalar(delta));

                // 5b. Hard Terrain Safety Clamp
                let currentTerrainHeight = world ? world.getHeightAt(this.mesh.position.x, this.mesh.position.z) : 0;
                if (this.mesh.position.y < currentTerrainHeight + 100) {
                    this.mesh.position.y = currentTerrainHeight + 100; // Skim the surface as a last resort
                }

                // 5c. Ceiling Safety Clamp (Universal)
                const CEILING = 15000;
                if (this.mesh.position.y > CEILING) {
                    this.mesh.position.y = CEILING;
                }

                // 5d. Floor Safety Clamp (Small adversaries only)
                if (!this.isAirship && this.mesh.position.y < 1000) {
                    this.mesh.position.y = 1000;
                }

                // 6. Simple Banking (Roll into turn)
                // We compare Up vector to World Up, or just fake it based on Y rotation diff?
                // Let's use a subtle roll based on the turn
                const zAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(this.mesh.quaternion);
                const projectedZ = new THREE.Vector3(zAxis.x, 0, zAxis.z).normalize();
                // Cross product of current direction and desired direction would give turn magnitude...
                // But simplified: Just constant bank for now not strictly necessary for 8-bit feel

                // Clear acceleration (unused now)
                this.acceleration.set(0, 0, 0);

                // Visual Model Rotation Sync (Already handled in syncWithConfig/animate usually, but ensuring)
                // The 'this.model' moves with 'this.mesh' group, so no extra sync needed here.

            } else {
                // --- AIRSHIP: AGGRESSIVE PREDATOR TRACKING ---
                this.speed = this.aiParams.speedMult;
                const GIANT_CEILING = 10000; // Altitude ceiling — giants cannot fly above this
                const GIANT_FLOOR = 2000; // Altitude floor — giants cannot fly below this

                if (player && player.mesh) {
                    // Track player with a UNIQUE OFFSET per giant (prevents convergence)
                    const playerPos = Adversary._tempVec.copy(player.mesh.position);

                    // Per-giant offset based on seed (spread them around the player)
                    const offsetAngle = this.seed * Math.PI * 2;
                    const offsetDist = 800 + this.seed * 1200; // 800-2000 unit spread
                    playerPos.x += Math.cos(offsetAngle) * offsetDist;
                    playerPos.z += Math.sin(offsetAngle) * offsetDist;
                    playerPos.y += (this.seed - 0.5) * 600; // Altitude variation

                    // Clamp target altitude to band so giants stay within limits
                    playerPos.y = Math.max(GIANT_FLOOR, Math.min(playerPos.y, GIANT_CEILING));

                    const m1 = Adversary._tempMat;
                    m1.lookAt(playerPos, this.mesh.position, this.mesh.up);

                    const targetQuaternion = Adversary._tempQuat;
                    targetQuaternion.setFromRotationMatrix(m1);

                    // Allow full 3D tracking (pitch and roll enabled)
                    // The giant will aim directly at its offset target point in 3D space
                    // euler.x = 0; // Removed pitch lock
                    // euler.z = 0; // Removed roll lock
                    // targetQuaternion.setFromEuler(euler);

                    // AGGRESSIVE tracking - snap to player quickly
                    const trackingSpeed = Math.min(0.5 * delta, 1.0);
                    this.mesh.quaternion.slerp(targetQuaternion, trackingSpeed);

                    // Distance Check - always fly fast
                    const distToPlayer = this.mesh.position.distanceTo(player.mesh.position);

                    // Speed scaling: faster when far, maintain speed when close
                    if (distToPlayer > 15000) {
                        this.speed = this.aiParams.speedMult * 6.0;
                    } else if (distToPlayer > 5000) {
                        this.speed = this.aiParams.speedMult * 3.0;
                    } else {
                        this.speed = this.aiParams.speedMult * 2.0;
                    }

                    // --- SEPARATION FORCE: AABB Collision Avoidance ---
                    if (this._allAdversaries && this.isAirship && this.localHitBox_Giant) {
                        // Update our world AABB for intersection tests
                        this.worldHitBox_Giant.copy(this.localHitBox_Giant).applyMatrix4(this.mesh.matrixWorld);

                        for (const other of this._allAdversaries) {
                            if (other === this || other.isDestroyed || !other.isAirship || !other.mesh || !other.localHitBox_Giant) continue;

                            // Update other giant's world AABB
                            other.worldHitBox_Giant.copy(other.localHitBox_Giant).applyMatrix4(other.mesh.matrixWorld);

                            // Check precise box-to-box intersection
                            if (this.worldHitBox_Giant.intersectsBox(other.worldHitBox_Giant)) {

                                const myCenter = this.worldHitBox_Giant.getCenter(Adversary._tempVec);
                                const otherCenter = other.worldHitBox_Giant.getCenter(Adversary._tempVec2);

                                // Calculate exact overlap on X and Z axes
                                const overlapX = Math.min(this.worldHitBox_Giant.max.x, other.worldHitBox_Giant.max.x) - Math.max(this.worldHitBox_Giant.min.x, other.worldHitBox_Giant.min.x);
                                const overlapZ = Math.min(this.worldHitBox_Giant.max.z, other.worldHitBox_Giant.max.z) - Math.max(this.worldHitBox_Giant.min.z, other.worldHitBox_Giant.min.z);

                                // We only resolve on the axis with the smallest overlap (least resistance)
                                if (overlapX > 0 && overlapZ > 0) {
                                    if (overlapX < overlapZ) {
                                        // Resolve on X
                                        const pushSign = (myCenter.x > otherCenter.x) ? 1 : -1;
                                        // Push apart instantly by half the overlap each, or full overlap for just this one. 
                                        // Since we iterate both ways, pushing this one away by half is smoother.
                                        this.mesh.position.x += (overlapX / 2 + 1.0) * pushSign;
                                    } else {
                                        // Resolve on Z
                                        const pushSign = (myCenter.z > otherCenter.z) ? 1 : -1;
                                        this.mesh.position.z += (overlapZ / 2 + 1.0) * pushSign;
                                    }
                                }

                                // Update world matrix immediately so chained checks reflect the new position
                                this.mesh.updateMatrixWorld();
                                this.worldHitBox_Giant.copy(this.localHitBox_Giant).applyMatrix4(this.mesh.matrixWorld);
                            }
                        }
                    }

                    // --- TEMPLE COLLISION AVOIDANCE ---
                    if (templeMesh && templeMesh.visible && this.localHitBox_Player) {
                        // Use the smaller 'Player' hitbox for temple collision as requested (blue bounding box)
                        const currentWorldHitBox = new THREE.Box3().copy(this.localHitBox_Player).applyMatrix4(this.mesh.matrixWorld);
                        const templeBox = new THREE.Box3().setFromObject(templeMesh);

                        if (currentWorldHitBox.intersectsBox(templeBox)) {
                            console.log("Giant hit the temple!");

                            const myCenter = currentWorldHitBox.getCenter(Adversary._tempVec);
                            const templeCenter = templeBox.getCenter(Adversary._tempVec2);

                            const overlapX = Math.min(currentWorldHitBox.max.x, templeBox.max.x) - Math.max(currentWorldHitBox.min.x, templeBox.min.x);
                            const overlapZ = Math.min(currentWorldHitBox.max.z, templeBox.max.z) - Math.max(currentWorldHitBox.min.z, templeBox.min.z);

                            if (overlapX > 0 && overlapZ > 0) {
                                // Push the giant completely OUT of the overlap in the path of least resistance
                                if (overlapX < overlapZ) {
                                    const pushSign = (myCenter.x > templeCenter.x) ? 1 : -1;
                                    this.mesh.position.x += overlapX * pushSign;
                                } else {
                                    const pushSign = (myCenter.z > templeCenter.z) ? 1 : -1;
                                    this.mesh.position.z += overlapZ * pushSign;
                                }
                            }
                            this.mesh.updateMatrixWorld();
                        }
                    }
                }
                // Fly FORWARD at speed
                this.mesh.translateZ(this.speed * delta * 8);

                // Hard-clamp altitude to band after movement
                if (this.mesh.position.y > GIANT_CEILING) {
                    this.mesh.position.y = GIANT_CEILING;
                } else if (this.mesh.position.y < GIANT_FLOOR) {
                    this.mesh.position.y = GIANT_FLOOR;
                }
            }

            // 3. Player Collision
            if (player && player.mesh && !player.crashed) {
                let isHit = false;

                if (this.isAirship && this.localHitBox_Player) {
                    // Safety Band: Player must be between 2000 and 10000 to collide with giants
                    const playerY = player.mesh.position.y;
                    if (playerY >= 2000 && playerY <= 10000) {
                        // 3A. Giant OBB collision - accounting for player's sheer size (250 radius)
                        const localPlayerPos = player.mesh.position.clone();
                        this.mesh.worldToLocal(localPlayerPos);
                        isHit = this.localHitBox_Player.distanceToPoint(localPlayerPos) < 250;
                    }
                } else {
                    // 3B. Regular Sphere collision
                    const playerDist = this.mesh.position.distanceTo(player.mesh.position);
                    const collisionRadius = this.collisionRadius || 270;
                    isHit = playerDist < collisionRadius;
                }

                // Collision Logic (with cooldown)
                if (isHit) {
                    if (!this._lastCollisionTime || (Date.now() - this._lastCollisionTime > 1000)) {
                        this._lastCollisionTime = Date.now();
                        console.log("MID-AIR COLLISION CONFIRMED!");

                        // Giants DON'T take collision damage (only killable by bullets)
                        if (!this.isAirship) {
                            this.hit();
                        }

                        if (player.takeDamage) {
                            player.takeDamage(1);
                        } else {
                            console.error("Player has no takeDamage method!");
                            player.crash();
                        }

                        // Play bonk sound if hit by a giant
                        if (this.isAirship && player.playBonkSound) {
                            player.playBonkSound();
                        }
                    }
                }
            }
        }

        this.position.copy(this.mesh.position);

        if (world) {
            // TERRAIN COLLISION REMOVED: Adversaries can fly through terrain to avoid random deaths
            /*
            const terrainHeight = world.getHeightAt(this.position.x, this.position.z);
            if (this.position.y <= terrainHeight + 1) {
                this.destroy(); // Disabled for now
            }
            */
        }
    }

    hit() {
        if (this.isDestroyed) return;

        this.health--;

        // Visual Feedback (Flash)
        if (this.model) {
            this.model.traverse(c => {
                if (c.isMesh && c.material) {
                    const oldColor = c.material.color.getHex();
                    c.material.color.setHex(0xffffff);
                    setTimeout(() => {
                        if (c && c.material) c.material.color.setHex(oldColor);
                    }, 50);
                }
            });
        }

        if (this.health <= 0) {
            // Play Death Sound (Man Screaming) ONLY on kill
            if (!this.muteDeathSound) {
                try {
                    const sound = new Audio(new URL('./assets/Man Screaming - CEEDAY Sound Effect (HD).mp3', import.meta.url).href);
                    sound.volume = 0.2; // 20%
                    // sound.currentTime = 1.0; // Full clip
                    sound.play().catch(() => { });

                    // Limit to 3 seconds of playback (Stop at T+3s)
                    setTimeout(() => {
                        sound.pause();
                        sound.src = "";
                    }, 3000);
                } catch (e) { }
            }

            this.destroy();
        }
    }

    increaseDifficulty(factor) {
        if (this.isDestroyed || this.isAirship) return;
        this.aiParams.speedMult *= factor;
        this.speed = this.aiParams.speedMult;
        // Optionally update maxSpeed if it was stored separately, but it's derived in update().
        // However, maxSpeed in update() uses aiParams.speedMult * 2.0, so it will automatically scale.
    }

    destroy() {
        if (this.isDestroyed) return;

        // Sound moved to hit() to ensure it only plays on kill, not cleanup

        this.isDestroyed = true;
        this.mesh.visible = false;

        // Removed storage listener cleanup
        if (this.damageCallback) this.damageCallback();
    }
}
