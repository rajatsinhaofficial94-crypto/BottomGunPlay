import * as THREE from 'three';

export class NukeExplosion {
    constructor(scene, position) {
        this.scene = scene;
        this.position = position.clone();

        // Settings
        this.maxSize = 25000;      // 25km radius! Huge!
        this.duration = 10.0;      // Very slow, dramatic explosion
        this.age = 0;

        this.active = true;

        // Container
        this.group = new THREE.Group();
        this.group.position.copy(this.position);
        this.scene.add(this.group);

        // 1. Center Flash (Blinding White/Yellow)
        // A sphere that quickly expands then fades
        const flashGeo = new THREE.SphereGeometry(1, 32, 32);
        this.flashMat = new THREE.MeshBasicMaterial({
            color: 0xffffee,
            transparent: true,
            opacity: 1.0,
            depthWrite: false
        });
        this.flashMesh = new THREE.Mesh(flashGeo, this.flashMat);
        this.group.add(this.flashMesh);

        // 2. Mushroom Cap (Expanding upward and outward)
        const capGeo = new THREE.SphereGeometry(1, 32, 16);
        // Squash it slightly to look more like a mushroom
        capGeo.scale(1, 0.6, 1);
        this.capMat = new THREE.MeshBasicMaterial({
            color: 0xffaa00,
            transparent: true,
            opacity: 0.9,
            depthWrite: false
        });
        this.capMesh = new THREE.Mesh(capGeo, this.capMat);
        this.group.add(this.capMesh);

        // 3. Shockwave Ring (Expanding horizontally along the ground)
        const ringGeo = new THREE.RingGeometry(0.9, 1.0, 64);
        ringGeo.rotateX(-Math.PI / 2); // Lay flat
        this.ringMat = new THREE.MeshBasicMaterial({
            color: 0xff5500,
            transparent: true,
            opacity: 0.8,
            side: THREE.DoubleSide,
            depthWrite: false
        });
        this.ringMesh = new THREE.Mesh(ringGeo, this.ringMat);
        // Start slightly above ground to prevent Z-fighting clipping early on
        this.ringMesh.position.y = 50;
        this.group.add(this.ringMesh);

        // Add extreme ambient lighting for dramatics
        this.light = new THREE.PointLight(0xffaa00, 100, this.maxSize * 1.5);
        this.light.position.y = 2000;
        this.group.add(this.light);
    }

    update(delta) {
        if (!this.active) return;

        this.age += delta;
        const progress = Math.min(this.age / this.duration, 1.0);

        if (progress >= 1.0) {
            this.destroy();
            return;
        }

        // --- ANIMATION CURVES ---

        // 1. Flash (Blows up fast, fades out early)
        const flashProgress = Math.min(this.age / (this.duration * 0.2), 1.0);
        const flashEpx = 1.0 - Math.pow(1.0 - flashProgress, 4); // Fast expand
        const flashScale = flashEpx * (this.maxSize * 0.4);
        this.flashMesh.scale.set(flashScale, flashScale, flashScale);
        this.flashMat.opacity = 1.0 - flashProgress;

        // 2. Mushroom Cap (Rises up, darkens over time)
        const capEpx = 1.0 - Math.pow(1.0 - progress, 3);
        const capScale = capEpx * this.maxSize;
        this.capMesh.scale.set(capScale, capScale, capScale);

        // Rise upwards over time
        this.capMesh.position.y = capEpx * (this.maxSize * 0.3);

        // Darken from bright yellow/orange to dark red/ash over time
        this.capMat.color.lerpColors(new THREE.Color(0xffaa00), new THREE.Color(0x330000), progress);
        // Fade out very slowly at the end
        if (progress > 0.7) {
            this.capMat.opacity = 0.9 * (1.0 - ((progress - 0.7) / 0.3));
        }

        // 3. Shockwave Ring (Linear expansion across the ground)
        // Travels super fast initially, then linear
        const ringScale = Math.pow(progress, 0.5) * this.maxSize * 1.5;
        this.currentRadius = ringScale; // Expose radius to game logic for destruction
        this.ringMesh.scale.set(ringScale, ringScale, ringScale);
        // Fade out
        this.ringMat.opacity = 0.8 * (1.0 - progress);

        // 4. Lighting
        this.light.intensity = 100 * (1.0 - progress);
    }

    destroy() {
        this.active = false;

        // Clean up geometries and materials to prevent memory leaks
        this.flashMesh.geometry.dispose();
        this.flashMat.dispose();

        this.capMesh.geometry.dispose();
        this.capMat.dispose();

        this.ringMesh.geometry.dispose();
        this.ringMat.dispose();

        this.scene.remove(this.group);

        // We do *not* nullify the meshes so anything relying on them simply stops seeing them
    }
}
