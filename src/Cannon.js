import * as THREE from 'three';

class Explosion {
    constructor(scene, position, maxScale = 1.0, color = 0xffaa00) {
        this.scene = scene;
        this.position = position.clone();
        this.lifeTime = 0.5 + (maxScale * 0.1); // Larger explosions last longer
        this.age = 0;
        this.maxScale = maxScale;

        // Visuals: Expanding Sphere
        const geometry = new THREE.SphereGeometry(5.0, 8, 8);
        const material = new THREE.MeshBasicMaterial({
            color: color,
            transparent: true,
            opacity: 1.0
        });
        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.position.copy(this.position);
        this.scene.add(this.mesh);
    }

    update(delta) {
        this.age += delta;
        const progress = this.age / this.lifeTime;

        if (progress >= 1.0) return false;

        // Expand and Fade
        const scale = 1.0 + (progress * 5.0 * this.maxScale);
        this.mesh.scale.set(scale, scale, scale);

        this.mesh.material.opacity = 1.0 - progress;

        return true;
    }

    dispose() {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
    }
}

class Projectile {
    constructor(scene, position, velocity) {
        this.scene = scene;
        this.position = position.clone();
        this.velocity = velocity.clone();

        // 1 game unit = ~4.44m. 9.8m/s^2 = ~2.2 units/s^2.
        this.gravity = new THREE.Vector3(0, -2.2, 0);

        this.dragCoeff = 0; // ZERO DRAG (Laser-like)
        this.lifeTime = 30.0; // Infinite range (30s at 1500 speed is 45km)
        this.age = 0;

        // Visuals
        const geometry = new THREE.CylinderGeometry(0.5, 0.5, 20.0, 8);
        geometry.rotateX(Math.PI / 2); // Align height with Z-axis for lookAt
        const material = new THREE.MeshBasicMaterial({ color: 0xffdd44 }); // Brighter Yellow-Orange
        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.position.copy(this.position);
        this.scene.add(this.mesh);

        // Store previous position for collision raycasting
        this.previousPosition = this.position.clone();
    }

    update(delta, world) {
        this.age += delta;
        this.previousPosition.copy(this.position);

        // Physics
        this.velocity.add(this.gravity.clone().multiplyScalar(delta));
        this.velocity.multiplyScalar(1 - (this.dragCoeff * delta));
        this.position.add(this.velocity.clone().multiplyScalar(delta));

        // Update Mesh
        this.mesh.position.copy(this.position);
        this.mesh.lookAt(this.position.clone().add(this.velocity));

        // Collision Detection (Ground)
        if (world) {
            const height = world.getHeightAt(this.position.x, this.position.z);
            if (this.position.y <= height) {
                return 'hit';
            }
        }

        return this.age < this.lifeTime ? 'active' : 'expired';
    }

    dispose() {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
    }
}

class Debris {
    constructor(scene, position) {
        this.scene = scene;
        this.position = position.clone();

        // Random Velocity (Explosive outward force)
        const speed = 500 + Math.random() * 1000;
        const angleX = Math.random() * Math.PI * 2;
        const angleY = Math.random() * Math.PI * 2;
        this.velocity = new THREE.Vector3(
            Math.sin(angleX) * Math.cos(angleY),
            Math.sin(angleY),
            Math.cos(angleX) * Math.cos(angleY)
        ).multiplyScalar(speed);

        this.gravity = new THREE.Vector3(0, -400, 0); // Heavy gravity
        this.lifeTime = 2.0 + Math.random() * 1.5;
        this.age = 0;

        // Visuals: Fiery Chunks
        const size = 10 + Math.random() * 20;
        const geometry = new THREE.BoxGeometry(size, size, size);
        const material = new THREE.MeshBasicMaterial({
            color: Math.random() > 0.5 ? 0xff5500 : 0x333333
        });
        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.position.copy(this.position);

        // Random Rotation
        this.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);

        this.scene.add(this.mesh);
    }

    update(delta) {
        this.age += delta;

        // Physics
        this.velocity.add(this.gravity.clone().multiplyScalar(delta));
        this.position.add(this.velocity.clone().multiplyScalar(delta));

        // Spin
        this.mesh.rotation.x += delta * 2;
        this.mesh.rotation.z += delta * 2;

        this.mesh.position.copy(this.position);

        return this.age < this.lifeTime;
    }

    dispose() {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
    }
}

export class Cannon {
    constructor(scene) {
        this.scene = scene;
        this.projectiles = [];
        this.explosions = [];
        this.debris = [];
        this.lastFireTime = 0;

        // Ammo System
        this.maxAmmo = 1000;
        this.ammo = this.maxAmmo;

        // Rate of Fire: 2000 RPM (Upgraded)
        this.rpm = 2000;
        this.fireInterval = 60 / this.rpm;

        // Muzzle Velocity (game units per second)
        // Extreme speed for "Laser" feel
        this.muzzleVelocity = 4500; // Tripled for supersonic combat (was 1500)

        // Audio Context for Procedural Sound
        this.audioCtx = null;
        this.initAudio();
    }

    initAudio() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) {
                this.audioCtx = new AudioContext();
            }
        } catch (e) {
            console.error("Web Audio API not supported", e);
        }

        // Boolets audio layer (loops while firing, layered on top of procedural sound)
        try {
            this.booletsAudio = new Audio(new URL('./assets/boolets.mp4', import.meta.url).href);
            this.booletsAudio.loop = true;
            this.booletsAudio.volume = 1.0;
            this.booletsPlaying = false;
        } catch (e) {
            console.error("Failed to load boolets audio", e);
        }
    }

    playShotSound() {
        if (!this.audioCtx) return;

        // Resume context if suspended (browser requirements)
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }

        const t = this.audioCtx.currentTime;

        // 1. Noise Burst (The "Bang")
        const bufferSize = this.audioCtx.sampleRate * 0.1; // 0.1 seconds
        const buffer = this.audioCtx.createBuffer(1, bufferSize, this.audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }

        const noise = this.audioCtx.createBufferSource();
        noise.buffer = buffer;

        // Filter for "thump"
        const filter = this.audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(800, t);
        filter.frequency.exponentialRampToValueAtTime(100, t + 0.1);

        // Envelope
        const gain = this.audioCtx.createGain();
        gain.gain.setValueAtTime(0.6, t); // 0.5 -> 0.6 (+20%)
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.1);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.audioCtx.destination);
        noise.start(t);
        noise.stop(t + 0.1);

        // 2. High Pitch Crack (The "Snap")
        const osc = this.audioCtx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(800, t);
        osc.frequency.exponentialRampToValueAtTime(100, t + 0.05);

        const oscGain = this.audioCtx.createGain();
        oscGain.gain.setValueAtTime(0.24, t); // 0.2 -> 0.24 (+20%)
        oscGain.gain.exponentialRampToValueAtTime(0.01, t + 0.05);

        osc.connect(oscGain);
        oscGain.connect(this.audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.05);
    }

    startBooletsAudio() {
        if (this.booletsAudio && !this.booletsPlaying) {
            this.booletsAudio.currentTime = 0;
            this.booletsAudio.play().catch(() => { });
            this.booletsPlaying = true;
        }
    }

    stopBooletsAudio() {
        if (this.booletsAudio && this.booletsPlaying) {
            this.booletsAudio.pause();
            this.booletsAudio.currentTime = 0;
            this.booletsPlaying = false;
        }
    }

    reload() {
        this.ammo = this.maxAmmo;
    }

    fire(origin, rotation, aircraftVelocity) {
        if (this.ammo <= 0) return; // Out of ammo

        const now = performance.now() / 1000;
        if (now - this.lastFireTime < this.fireInterval) return;

        this.lastFireTime = now;
        this.ammo--; // Decrement ammo

        // Play Sound (procedural + boolets layer)
        this.playShotSound();
        this.startBooletsAudio();

        // Muzzle position (Port side offset)
        const offset = new THREE.Vector3(-0.5, 0, 2);
        offset.applyQuaternion(rotation);
        const spawnPos = origin.clone().add(offset);

        // Direction
        const direction = new THREE.Vector3(0, 0, -1);
        direction.applyQuaternion(rotation);

        // Spread
        const spread = 0.002;
        direction.x += (Math.random() - 0.5) * spread;
        direction.y += (Math.random() - 0.5) * spread;
        direction.normalize();

        const bulletVel = direction.multiplyScalar(this.muzzleVelocity);

        if (aircraftVelocity) {
            bulletVel.add(aircraftVelocity);
        }

        const projectile = new Projectile(this.scene, spawnPos, bulletVel);
        this.projectiles.push(projectile);
    }

    createExplosion(position, scale = 1.0, color = 0xffaa00) {
        const explosion = new Explosion(this.scene, position, scale, color);
        this.explosions.push(explosion);
    }

    createMegaExplosion(position) {
        // 1. Core Flash (White/Yellow, Fast)
        this.createExplosion(position, 3.0, 0xffffaa);

        // 2. Main Fireball (Orange, Huge)
        this.createExplosion(position, 8.0, 0xff5500); // Massive 8x scale (40 units)

        // 3. Smoke/Outer (Darker, even bigger)
        this.createExplosion(position, 12.0, 0x444444);

        // 4. Debris (Flying Fragments) - REMOVED for Performance
        // const debrisCount = 20 + Math.floor(Math.random() * 10);
        // for (let i = 0; i < debrisCount; i++) {
        //     const debris = new Debris(this.scene, position);
        //     this.debris.push(debris);
        // }
    }

    update(delta, world, targets = [], oilBottleMesh = null, templeMesh = null, easterEggCube = null) {
        // Pre-compute oil bottle and temple bounding boxes (world-space) if provided
        let oilBox = null;
        let templeBox = null;
        if (oilBottleMesh && oilBottleMesh.visible) {
            oilBox = new THREE.Box3().setFromObject(oilBottleMesh);
        }
        if (templeMesh && templeMesh.visible) {
            templeBox = new THREE.Box3().setFromObject(templeMesh);
        }
        let easterEggBox = null;
        if (easterEggCube && easterEggCube.visible) {
            easterEggBox = new THREE.Box3().setFromObject(easterEggCube);
        }

        // Update Projectiles
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const p = this.projectiles[i];
            const status = p.update(delta, world);
            let hitTarget = false;

            if (status === 'active') {
                // --- Easter Egg Cube Collision Check ---
                if (easterEggBox) {
                    const dir = p.position.clone().sub(p.previousPosition);
                    const segLen = dir.length();
                    if (segLen > 0) {
                        const ray = new THREE.Ray(p.previousPosition.clone(), dir.normalize());
                        const hitDist = ray.intersectBox(easterEggBox, new THREE.Vector3());
                        if (hitDist !== null && ray.origin.distanceTo(hitDist) <= segLen) {
                            const cubePos = new THREE.Vector3();
                            easterEggCube.getWorldPosition(cubePos);

                            console.log('EASTER EGG CUBE HIT!');
                            this.createExplosion(cubePos, 5.0, 0xff0000);
                            easterEggCube.visible = false;
                            window.dispatchEvent(new Event('trumpEasterEgg'));

                            p.dispose();
                            this.projectiles.splice(i, 1);
                            hitTarget = true;
                            continue;
                        }
                    }
                }

                // --- Oil Bottle Collision Check (before adversary loop) ---
                if (oilBox && oilBox.containsPoint(p.position)) {
                    // Check if the temple is occluding this bullet's path.
                    // We cast a segment from previousPosition -> currentPosition and see if
                    // it intersects the temple bounding box.
                    let occludedByTemple = false;
                    if (templeBox) {
                        // Use THREE.Ray to check segment vs AABB
                        const dir = p.position.clone().sub(p.previousPosition);
                        const segLen = dir.length();
                        if (segLen > 0) {
                            const ray = new THREE.Ray(p.previousPosition.clone(), dir.normalize());
                            const hitDist = ray.intersectBox(templeBox, new THREE.Vector3());
                            if (hitDist !== null && ray.origin.distanceTo(hitDist) <= segLen) {
                                occludedByTemple = true;
                            }
                        }
                    }

                    if (occludedByTemple) {
                        // Temple wall absorbed the bullet — just a hit on the temple, no game over
                        this.createExplosion(p.position, 0.5);
                    } else {
                        // Direct hit on the oil bottle — GAME OVER
                        console.log('OIL BOTTLE HIT! GAME OVER!');
                        this.createExplosion(p.position, 2.0, 0xff6600);
                        document.dispatchEvent(new Event('gameover'));
                    }

                    p.dispose();
                    this.projectiles.splice(i, 1);
                    hitTarget = true;
                }

                // Check Adversary Targets
                if (!hitTarget && targets.length > 0) {
                    for (const target of targets) {
                        if (target.isDestroyed || !target.mesh) continue;

                        let bulletHit = false;

                        if (target.isAirship && target.localHitBox_Player) {
                            // 1. Giant AABB Hitbox
                            const localBulletPos = p.position.clone();
                            target.mesh.worldToLocal(localBulletPos);
                            if (target.localHitBox_Player.containsPoint(localBulletPos)) {
                                bulletHit = true;
                            }
                        } else {
                            // 2. Regular Sphere Proximity
                            const dist = p.position.distanceTo(target.mesh.position);
                            const proximityRadius = target.hitRadius || target.collisionRadius || 200;
                            if (dist < proximityRadius) {
                                bulletHit = true;
                            }
                        }

                        if (bulletHit) {
                            target.hit();
                            this.createExplosion(p.position);
                            p.dispose();
                            this.projectiles.splice(i, 1);
                            hitTarget = true;
                            break; // One bullet, one hit
                        }
                    }
                }
            }

            if (!hitTarget) {
                if (status === 'hit' || status === 'expired') {
                    if (status === 'hit') this.createExplosion(p.position);
                    p.dispose();
                    this.projectiles.splice(i, 1);
                }
            }
        }

        // Update Explosions
        for (let i = this.explosions.length - 1; i >= 0; i--) {
            const ex = this.explosions[i];
            const active = ex.update(delta);
            if (!active) {
                ex.dispose();
                this.explosions.splice(i, 1);
            }
        }

        // Update Debris
        for (let i = this.debris.length - 1; i >= 0; i--) {
            const d = this.debris[i];
            const active = d.update(delta);
            if (!active) {
                d.dispose();
                this.debris.splice(i, 1);
            }
        }
    }
}
