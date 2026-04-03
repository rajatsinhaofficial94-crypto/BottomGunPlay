import * as THREE from 'three';
import { GLTFLoader } from './lib/GLTFLoader.js';
import { FBXLoader } from './lib/FBXLoader.js';

// Simple Simplex Noise implementation (or similar pseudo-random noise)
// For simplicity and speed in a single file without external deps, we'll use a basic permutation table noise.
// Or better: Use a simple custom noise function.

class SimpleNoise {
    constructor() {
        this.perm = new Uint8Array(512);
        this.grad3 = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
        [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
        [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]];
        for (let i = 0; i < 512; i++) {
            this.perm[i] = Math.floor(Math.random() * 255);
        }
    }

    dot(g, x, y) {
        return g[0] * x + g[1] * y;
    }

    noise(xin, yin) {
        let n0, n1, n2; // Noise contributions from the three corners
        // Skew the input space to determine which simplex cell we're in
        const F2 = 0.5 * (Math.sqrt(3.0) - 1.0);
        const s = (xin + yin) * F2; // Hairy factor for 2D
        const i = Math.floor(xin + s);
        const j = Math.floor(yin + s);
        const G2 = (3.0 - Math.sqrt(3.0)) / 6.0;
        const t = (i + j) * G2;
        const X0 = i - t; // Unskew the cell origin back to (x,y) space
        const Y0 = j - t;
        const x0 = xin - X0; // The x,y distances from the cell origin
        const y0 = yin - Y0;
        // For the 2D case, the simplex shape is an equilateral triangle.
        // Determine which simplex we are in.
        let i1, j1; // Offsets for second (middle) corner of simplex in (i,j) coords
        if (x0 > y0) { i1 = 1; j1 = 0; } // lower triangle, XY order: (0,0)->(1,0)->(1,1)
        else { i1 = 0; j1 = 1; }      // upper triangle, YX order: (0,0)->(0,1)->(1,1)
        // A step of (1,0) in (i,j) means a step of (1-c,-c) in (x,y), and
        // a step of (0,1) in (i,j) means a step of (-c,1-c) in (x,y), where
        // c = (3-sqrt(3))/6
        const x1 = x0 - i1 + G2; // Offsets for middle corner in (x,y) unskewed coords
        const y1 = y0 - j1 + G2;
        const x2 = x0 - 1.0 + 2.0 * G2; // Offsets for last corner in (x,y) unskewed coords
        const y2 = y0 - 1.0 + 2.0 * G2;
        // Work out the hashed gradient indices of the three simplex corners
        const ii = i & 255;
        const jj = j & 255;
        // Calculate the contribution from the three corners
        let t0 = 0.5 - x0 * x0 - y0 * y0;
        if (t0 < 0) n0 = 0.0;
        else {
            t0 *= t0;
            n0 = t0 * t0 * this.dot(this.grad3[this.perm[ii + this.perm[jj]] % 12], x0, y0);
        }
        let t1 = 0.5 - x1 * x1 - y1 * y1;
        if (t1 < 0) n1 = 0.0;
        else {
            t1 *= t1;
            n1 = t1 * t1 * this.dot(this.grad3[this.perm[ii + i1 + this.perm[jj + j1]] % 12], x1, y1);
        }
        let t2 = 0.5 - x2 * x2 - y2 * y2;
        if (t2 < 0) n2 = 0.0;
        else {
            t2 *= t2;
            n2 = t2 * t2 * this.dot(this.grad3[this.perm[ii + 1 + this.perm[jj + 1]] % 12], x2, y2);
        }
        // Add contributions from each corner to get the final noise value.
        // The result is scaled to return values in the interval [-1,1].
        return 70.0 * (n0 + n1 + n2);
    }
}

export class World {
    constructor(scene) {
        this.scene = scene;
        this.noise = new SimpleNoise();

        // Config
        this.chunkSize = 5000; // Larger chunks for 80k range
        this.resolution = 64;  // Ultra-Res (64) for maximum GPU utilization (Was 32)

        // Materials
        this.terrainMaterial = new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.8,
            metalness: 0.1,
            flatShading: true,
            side: THREE.DoubleSide
        });

        // Vegetation Mesh (Simple Pyramid)
        const treeGeo = new THREE.ConeGeometry(20, 80, 4);
        treeGeo.translate(0, 40, 0); // Pivot at base
        const treeMat = new THREE.MeshStandardMaterial({ color: 0x1a472a, flatShading: true });
        this.treeMesh = new THREE.InstancedMesh(treeGeo, treeMat, 20000); // 20k trees (Dense Forests)
        this.treeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.scene.add(this.treeMesh);

        this.dummy = new THREE.Object3D();
        this.treeCount = 0;

        this.chunks = new Map();
        this.chunkQueue = []; // For temporal generation (one per frame)

        // Lighting
        const ambient = new THREE.AmbientLight(0x666666);
        this.scene.add(ambient);

        const sunlight = new THREE.DirectionalLight(0xffffff, 1.0);
        sunlight.position.set(1000, 2000, 500);
        sunlight.castShadow = true;
        sunlight.shadow.mapSize.width = 4096; // Ultra Quality Shadows
        sunlight.shadow.mapSize.height = 4096;
        // Optimize shadow camera frustum for large terrain
        sunlight.shadow.camera.near = 0.5;
        sunlight.shadow.camera.far = 5000;
        sunlight.shadow.camera.left = -2000;
        sunlight.shadow.camera.right = 2000;
        sunlight.shadow.camera.top = 2000;
        sunlight.shadow.camera.bottom = -2000;
        this.scene.add(sunlight);

        // Initial generation
        this.updateChunks(new THREE.Vector3(0, 500, 0), true); // Synchronous first pass

        this.loadTemple();
        this.loadTrumpEasterEgg();
    }

    loadTemple() {
        const loader = new GLTFLoader();
        loader.load('./src/assets/fixedtemple2.glb', (gltf) => {
            const temple = gltf.scene;

            // Get height at center (0, 0)
            const height = this.getProceduralHeight(0, 0);

            // Insert at zero point of the map, and set Y to height initially
            temple.position.set(0, height, 0);

            // Increase size by 15.0 times (1.5x the previous 10.0x)
            temple.scale.set(15.0, 15.0, 15.0);

            // Calculate precise bounding box to stop it from sinking into the ground
            temple.updateMatrixWorld(true);
            const rawBbox = new THREE.Box3().setFromObject(temple);
            const templeBottom = rawBbox.min.y;

            // Shift the temple up so its very bottom rests exactly on the map height
            temple.position.y += (height - templeBottom);
            temple.updateMatrixWorld(true); // Update after shift

            // Recalculate physical bounding box
            const bbox = new THREE.Box3().setFromObject(temple);
            this.templeHitBox = bbox.clone();

            // Load Domino's Logo Texture
            const textureLoader = new THREE.TextureLoader();
            const dominosTex = textureLoader.load('./src/assets/dominos_logo.png');
            dominosTex.flipY = false;

            // Enable shadows for realism
            temple.traverse((child) => {
                if (child.name === 'Cube') {
                    this.easterEggCube = child;
                    child.traverse((descendant) => {
                        if (descendant.isMesh) {
                            descendant.material = new THREE.MeshStandardMaterial({
                                map: dominosTex,
                                roughness: 0.8,
                                metalness: 0.1
                            });
                        }
                    });
                }
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                }
            });

            this.templeMesh = temple;
            this.scene.add(temple);

            console.log("Temple model successfully loaded at zero point of map!");
        }, undefined, (error) => {
            console.error('Error loading temple model:', error);
        });
    }

    loadTrumpEasterEgg() {
        // Wrap Trump in a Group so we can offset his local pivot safely!
        this.trumpModel = new THREE.Group();
        this.trumpModel.visible = false;
        this.scene.add(this.trumpModel);

        // Load the diffuse texture with Three.js default settings (flipY=true)
        const textureLoader = new THREE.TextureLoader();
        const texture = textureLoader.load('./src/assets/trump_dif_txt.png');
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.offset.set(0, 0);
        texture.repeat.set(1, 1);

        const loader = new FBXLoader();
        loader.load('./src/assets/Running.fbx', (fbx) => {
            // Unconditionally apply our texture to every mesh 
            fbx.traverse((child) => {
                if (child.isMesh) {
                    child.material = new THREE.MeshPhongMaterial({
                        map: texture,
                    });
                    child.castShadow = true;
                    child.receiveShadow = true;
                }
            });

            this.trumpModel.add(fbx);

            // Wait for temple to be loaded to scale to its height
            let scaleAttempt = 0;
            const checkTemple = setInterval(() => {
                scaleAttempt++;
                if (this.templeMesh) {
                    clearInterval(checkTemple);
                    const templeBox = new THREE.Box3().setFromObject(this.templeMesh);
                    const templeHeight = templeBox.max.y - templeBox.min.y;

                    fbx.updateMatrixWorld(true);
                    const trumpBox = new THREE.Box3().setFromObject(fbx);
                    const trumpHeight = trumpBox.max.y - trumpBox.min.y;

                    if (templeHeight > 0 && trumpHeight > 0) {
                        const scaleFactor = (templeHeight / trumpHeight) * 0.75; // 1.5x of previous size
                        fbx.scale.set(scaleFactor, scaleFactor, scaleFactor);
                        fbx.userData.isTrump = true; // Mark so bullets skip him
                        console.log(`Trump FBX scaled to ${scaleFactor}`);

                        // Re-evaluate bounding box after scale
                        fbx.updateMatrixWorld(true);
                        const newBox = new THREE.Box3().setFromObject(fbx);
                        // Offset inner mesh so feet reach ground
                        fbx.position.y -= newBox.min.y;
                        fbx.position.y += 500; // lift above grass
                    }
                }
                if (scaleAttempt > 100) clearInterval(checkTemple);
            }, 500);

            console.log('Trump FBX model loaded!');
        }, undefined, (error) => {
            console.error('Error loading Trump FBX model:', error);
        });
    }

    getProceduralHeight(x, z) {
        // Multi-octave noise
        // Large features (mountains)
        let y = this.noise.noise(x * 0.0002, z * 0.0002) * 800;
        // Medium features (hills)
        y += this.noise.noise(x * 0.001, z * 0.001) * 200;
        // Small detail (roughness)
        y += this.noise.noise(x * 0.005, z * 0.005) * 30;

        const rawHeight = Math.max(-100, y);

        // --- Temple Plateau Flattening ---
        const distFromCenter = Math.sqrt(x * x + z * z);
        const flattenRadius = 6000; // Flat safe zone for the temple (Doubled again)
        const blendRadius = 4000;   // Distance over which it blends back to normal terrain (Doubled again)
        const flatHeight = 60;      // 60 = Deep Grass coloring

        if (distFromCenter < flattenRadius) {
            return flatHeight;
        } else if (distFromCenter < flattenRadius + blendRadius) {
            // Smoothly blend the flat plateau into the rolling hills
            const t = (distFromCenter - flattenRadius) / blendRadius;
            const smoothT = t * t * (3 - 2 * t);
            return flatHeight + (rawHeight - flatHeight) * smoothT;
        }

        return rawHeight;
    }

    createChunk(cx, cy) {
        const geometry = new THREE.PlaneGeometry(
            this.chunkSize, this.chunkSize,
            this.resolution, this.resolution
        );
        geometry.rotateX(-Math.PI / 2);

        const positions = geometry.attributes.position.array;
        const colors = [];
        const treeCandidates = [];

        for (let i = 0; i < positions.length; i += 3) {
            const vx = positions[i] + cx * this.chunkSize;
            const vz = positions[i + 2] + cy * this.chunkSize;

            const h = this.getProceduralHeight(vx, vz);
            positions[i + 1] = h;

            let c = new THREE.Color();
            if (h < 0) c.setHex(0x224488);
            else if (h < 50) c.setHex(0xe0d8a0);
            else if (h < 400) c.setHex(0x4a8d4a);
            else if (h < 900) c.setHex(0x6e5c4d);
            else c.setHex(0xffffff);

            colors.push(c.r, c.g, c.b);

            if (h > 50 && h < 400 && Math.random() < 0.02) {
                // Ensure no trees spawn directly under or inside the Temple footprint
                const distFromCenter = Math.sqrt(vx * vx + vz * vz);
                if (distFromCenter > 6400) {
                    treeCandidates.push({ x: vx, y: h, z: vz });
                }
            }
        }

        geometry.computeVertexNormals();
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

        const mesh = new THREE.Mesh(geometry, this.terrainMaterial);
        mesh.position.set(cx * this.chunkSize, 0, cy * this.chunkSize);
        this.scene.add(mesh);

        if (treeCandidates.length > 0) {
            const iMesh = new THREE.InstancedMesh(this.treeMesh.geometry, this.treeMesh.material, treeCandidates.length);
            for (let k = 0; k < treeCandidates.length; k++) {
                this.dummy.position.set(treeCandidates[k].x - (cx * this.chunkSize), treeCandidates[k].y, treeCandidates[k].z - (cy * this.chunkSize));
                const s = 0.8 + Math.random() * 0.5;
                this.dummy.scale.set(s, s, s);
                this.dummy.rotation.y = Math.random() * Math.PI * 2;
                this.dummy.updateMatrix();
                iMesh.setMatrixAt(k, this.dummy.matrix);
            }
            iMesh.position.set(cx * this.chunkSize, 0, cy * this.chunkSize);
            iMesh.instanceMatrix.needsUpdate = true;
            this.scene.add(iMesh);
            mesh.userData.trees = iMesh;
        }

        return mesh;
    }

    updateChunks(pos, synchronous = false) {
        const cx = Math.round(pos.x / this.chunkSize);
        const cy = Math.round(pos.z / this.chunkSize);

        const dist = 16; // Ultra-range rendering (80k Range)
        const newKeys = new Set();

        // 1. Identify missing chunks
        for (let x = cx - dist; x <= cx + dist; x++) {
            for (let y = cy - dist; y <= cy + dist; y++) {
                const key = `${x},${y}`;
                newKeys.add(key);
                if (!this.chunks.has(key)) {
                    if (synchronous) {
                        this.chunks.set(key, this.createChunk(x, y));
                    } else if (!this.chunkQueue.includes(key)) {
                        this.chunkQueue.push(key);
                    }
                }
            }
        }

        // 2. Cleanup out-of-range chunks
        for (const [key, mesh] of this.chunks) {
            if (!newKeys.has(key)) {
                this.scene.remove(mesh);
                if (mesh.userData.trees) {
                    this.scene.remove(mesh.userData.trees);
                    mesh.userData.trees.dispose();
                }
                mesh.geometry.dispose();
                this.chunks.delete(key);
            }
        }

        // 3. Temporal Generation (One per frame)
        if (!synchronous && this.chunkQueue.length > 0) {
            // Priority: Closest to player
            this.chunkQueue.sort((a, b) => {
                const [ax, ay] = a.split(',').map(Number);
                const [bx, by] = b.split(',').map(Number);
                const da = Math.pow(ax - cx, 2) + Math.pow(ay - cy, 2);
                const db = Math.pow(bx - cx, 2) + Math.pow(by - cy, 2);
                return da - db;
            });

            const nextKey = this.chunkQueue.shift();
            if (nextKey && !this.chunks.has(nextKey)) {
                const [nx, ny] = nextKey.split(',').map(Number);
                this.chunks.set(nextKey, this.createChunk(nx, ny));
            }
        }
    }

    update(pos) {
        this.updateChunks(pos);
    }

    getHeightAt(x, z) {
        return this.getProceduralHeight(x, z);
    }
}
