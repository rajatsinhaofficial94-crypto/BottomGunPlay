import * as THREE from 'three';
import { GLTFLoader } from './lib/GLTFLoader.js';

class PizzaExplosion {
    constructor(scene, position) {
        this.scene = scene;
        this.position = position.clone();
        this.lifeTime = 1.5;
        this.maxScale = 120.0; // Reduced visual blast

        const geometry = new THREE.SphereGeometry(15.0, 16, 16);
        const material = new THREE.MeshBasicMaterial({
            color: 0xff3300,
            transparent: true,
            opacity: 1.0,
            blending: THREE.AdditiveBlending
        });
        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.position.copy(this.position);
        this.scene.add(this.mesh);

        // Secondary flash
        this.mesh2 = new THREE.Mesh(
            new THREE.SphereGeometry(10.0, 8, 8),
            new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true })
        );
        this.mesh2.position.copy(this.position);
        this.scene.add(this.mesh2);
    }

    update(delta) {
        this.age += delta;
        const progress = this.age / this.lifeTime;

        if (progress >= 1.0) return false;

        const scale = 1.0 + (progress * this.maxScale);
        this.mesh.scale.set(scale, scale, scale);
        this.mesh.material.opacity = 1.0 - progress;

        const scale2 = 1.0 + (progress * this.maxScale * 0.5);
        this.mesh2.scale.set(scale2, scale2, scale2);
        this.mesh2.material.opacity = (1.0 - progress) * 0.8;

        return true;
    }

    dispose() {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
        this.scene.remove(this.mesh2);
        this.mesh2.geometry.dispose();
        this.mesh2.material.dispose();
    }
}

class PizzaProjectile {
    constructor(scene, position, velocity, modelTemplate) {
        this.scene = scene;
        this.position = position.clone();
        this.velocity = velocity.clone(); // Slow! E.g. 500 + aircraft velocity
        this.lifeTime = 20.0;
        this.age = 0;

        // Blast radius reduced to a reasonable cluster size
        this.blastRadius = 6000;

        if (modelTemplate) {
            this.mesh = modelTemplate.clone();
        } else {
            // Fallback (if not loaded yet)
            this.mesh = new THREE.Mesh(
                new THREE.CylinderGeometry(5, 5, 1),
                new THREE.MeshBasicMaterial({ color: 0xff8800 })
            );
            this.mesh.rotateX(Math.PI / 2);
        }

        this.mesh.position.copy(this.position);

        // Scale it up so it's visible (might need tuning depending on glb scale)
        this.mesh.scale.set(80, 80, 80);
        this.scene.add(this.mesh);
    }

    update(delta, world) {
        this.age += delta;

        this.position.add(this.velocity.clone().multiplyScalar(delta));
        this.mesh.position.copy(this.position);

        // Spin the pizza for realism
        this.mesh.rotation.x += delta * 2;
        this.mesh.rotation.y += delta * 3;
        this.mesh.rotation.z += delta * 4;

        if (world) {
            const height = world.getHeightAt(this.position.x, this.position.z);
            if (this.position.y <= height) {
                return 'hit'; // Explodes on terrain
            }
        }

        return this.age < this.lifeTime ? 'active' : 'expired';
    }

    dispose() {
        this.scene.remove(this.mesh);
        // We only dispose geometry if it's the fallback cylinder, else we leave template
        if (this.mesh.geometry && this.mesh.geometry.type === 'CylinderGeometry') {
            this.mesh.geometry.dispose();
            this.mesh.material.dispose();
        }
    }
}

export class PizzaWeapon {
    constructor(scene) {
        this.scene = scene;
        this.projectiles = [];
        this.explosions = [];

        this.ammo = 3;
        this.muzzleVelocity = 2500; // Increased flight speed

        this.pizzaModel = null;

        const loader = new GLTFLoader();
        loader.load('./src/assets/pizza.glb', (gltf) => {
            this.pizzaModel = gltf.scene;
            console.log("Pizza model loaded!");
        });
    }

    canFire() {
        return this.ammo > 0;
    }

    fire(origin, rotation, aircraftVelocity) {
        if (!this.canFire()) return;

        this.ammo--;
        console.log(`Pizzas remaining: ${this.ammo}`);

        // Update visual pizza meter
        const pizzaMeter = document.getElementById('pizza-meter');
        if (pizzaMeter) {
            pizzaMeter.innerText = '🍕'.repeat(this.ammo);
        }

        // Fire straight
        const direction = new THREE.Vector3(0, 0, -1);
        direction.applyQuaternion(rotation);

        const bulletVel = direction.multiplyScalar(this.muzzleVelocity);
        if (aircraftVelocity) {
            bulletVel.add(aircraftVelocity);
        }

        // Spawn slightly ahead
        const offset = new THREE.Vector3(0, -20, -60).applyQuaternion(rotation);
        const spawnPos = origin.clone().add(offset);

        const proj = new PizzaProjectile(this.scene, spawnPos, bulletVel, this.pizzaModel);
        this.projectiles.push(proj);
    }

    createExplosion(position) {
        const explosion = new PizzaExplosion(this.scene, position);
        this.explosions.push(explosion);

        // Massive screen shake
        const hud = document.getElementById('combat-hud');
        if (hud) {
            hud.classList.add('hud-vibrate');

            // Audio cue
            try {
                const boom = new Audio(new URL('./assets/Man Screaming - CEEDAY Sound Effect (HD).mp3', import.meta.url).href);
                boom.volume = 0.5;
                boom.play().catch(() => { });
            } catch (e) { }

            setTimeout(() => hud.classList.remove('hud-vibrate'), 800);
        }
    }

    update(delta, world, targets = []) {
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const p = this.projectiles[i];
            const status = p.update(delta, world);
            let hitTarget = false;

            // Check direct hit or proximity (Pizza has huge proximity fuse)
            if (status === 'active' && targets.length > 0) {
                for (const target of targets) {
                    if (target.isDestroyed || !target.mesh) continue;

                    const dist = p.position.distanceTo(target.mesh.position);
                    // Proximity fuse: 1500 for airships, 800 for regulars
                    const proximity = target.isAirship ? 1500 : 800;
                    if (dist < proximity) {
                        hitTarget = true;
                        break;
                    }
                }
            }

            if (hitTarget || status === 'hit') {
                this.createExplosion(p.position);

                // Do massive area damage (NUKE)
                if (targets.length > 0) {
                    for (const target of targets) {
                        if (target.isDestroyed || !target.mesh) continue;
                        const d = p.position.distanceTo(target.mesh.position);
                        if (d < p.blastRadius) {
                            // Instant kill
                            target.health = 0;
                            target.hit(); // let it handle destroy logic
                        }
                    }
                }

                p.dispose();
                this.projectiles.splice(i, 1);
            } else if (status === 'expired') {
                p.dispose();
                this.projectiles.splice(i, 1);
            }
        }

        for (let i = this.explosions.length - 1; i >= 0; i--) {
            if (!this.explosions[i].update(delta)) {
                this.explosions[i].dispose();
                this.explosions.splice(i, 1);
            }
        }
    }
}
