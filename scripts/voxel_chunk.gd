class_name VoxelChunk
extends StaticBody3D

const CHUNK_SIZE = 16
var voxels = [] # Stores packed int: color_idx + (tex_idx << 8)
var mesh_instance: MeshInstance3D
var collision_shape: CollisionShape3D

static var shared_material: StandardMaterial3D = null

const PALETTE = [
	Color("#ffffff"), # 0 unused
	# Forest & Cliff (1-8)
	Color("#5ac54f"), Color("#3e8948"), Color("#265c42"), Color("#8cd656"),
	Color("#8a5844"), Color("#6d4234"), Color("#523126"), Color("#a87056"),
	# Frost & Crystal (9-16)
	Color("#e3f8ff"), Color("#99e6ff"), Color("#38c6d9"), Color("#1685a8"),
	Color("#0f5573"), Color("#6b8299"), Color("#485869"), Color("#ffffff"),
	# Desert & Gold (17-24)
	Color("#ffe678"), Color("#f5c242"), Color("#d99126"), Color("#b36b19"),
	Color("#e8c170"), Color("#c49a52"), Color("#8c6b3b"), Color("#544026"),
	# Volcanic & Obsidian (25-32)
	Color("#ff5232"), Color("#ff8c24"), Color("#c42430"), Color("#42393b"),
	Color("#2b2527"), Color("#1a1618"), Color("#635659"), Color("#ffdb4d")
]

func _init():
	voxels.resize(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE)
	voxels.fill(0)
	mesh_instance = MeshInstance3D.new()
	collision_shape = CollisionShape3D.new()
	add_child(mesh_instance)
	add_child(collision_shape)
	if shared_material == null:
		shared_material = _create_pixel_atlas_material()

static func _create_pixel_atlas_material() -> StandardMaterial3D:
	# 8 texture types side-by-side (each 16x16 pixels = 128x16 atlas)
	var img = Image.create(128, 16, false, Image.FORMAT_RGBA8)
	for t in range(8):
		var ox = t * 16
		for y in range(16):
			for x in range(16):
				var v = 0.96
				# Crisp voxel border outline
				if x == 0 or y == 0 or x == 15 or y == 15:
					v = 0.84
				if t == 0: # Grass Block (top fringe & noise)
					if y < 4 or (y == 4 and (x % 3 == 0)): v = 1.04
					elif (x * 7 + y * 13) % 5 == 0: v = 0.88
				elif t == 2: # Ice Crystal (diagonal shine)
					if (x + y) in [5, 6, 17, 18]: v = 1.15
				elif t == 3: # Magma cracks
					if (x * 3 + y * 5) % 9 == 0: v = 1.2
					elif (x + y) % 4 == 0: v = 0.78
				elif t == 4: # Stone Brick mortar
					if y % 8 == 0 or ((x + (y / 8) * 8) % 16 == 0): v = 0.72
				elif t == 5: # Wood Planks
					if y % 4 == 0 or (x == 8 and (y / 4) % 2 == 0): v = 0.76
				elif t == 6: # Sand speckles
					if (x * 11 + y * 7) % 6 == 0: v = 0.88
				elif t == 7: # Leaf checkerboard
					if (x + y) % 2 == 0: v = 0.86
				img.set_pixel(ox + x, y, Color(v, v, v, 1.0))

	var tex = ImageTexture.create_from_image(img)
	var mat = StandardMaterial3D.new()
	mat.vertex_color_use_as_albedo = true
	mat.albedo_texture = tex
	mat.texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST
	mat.roughness = 0.9
	return mat

func get_index(x: int, y: int, z: int) -> int:
	return x + CHUNK_SIZE * (y + CHUNK_SIZE * z)

func get_voxel(x: int, y: int, z: int) -> int:
	if x < 0 or x >= CHUNK_SIZE or y < 0 or y >= CHUNK_SIZE or z < 0 or z >= CHUNK_SIZE:
		return 0
	return voxels[get_index(x, y, z)]

func set_voxel(x: int, y: int, z: int, value: int):
	if x >= 0 and x < CHUNK_SIZE and y >= 0 and y < CHUNK_SIZE and z >= 0 and z < CHUNK_SIZE:
		voxels[get_index(x, y, z)] = value

func rebuild_mesh():
	var st = SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	
	for axis in range(3):
		var u = (axis + 1) % 3
		var v = (axis + 2) % 3
		var x = [0, 0, 0]
		var q = [0, 0, 0]
		q[axis] = 1
		
		var mask = []
		mask.resize(CHUNK_SIZE * CHUNK_SIZE)
		
		for d in range(-1, CHUNK_SIZE):
			x[axis] = d
			var n = 0
			for j in range(CHUNK_SIZE):
				x[v] = j
				for i in range(CHUNK_SIZE):
					x[u] = i
					var a = get_voxel(x[0], x[1], x[2])
					var b = get_voxel(x[0] + q[0], x[1] + q[1], x[2] + q[2])
					if (a != 0) == (b != 0):
						mask[n] = 0
					elif a != 0:
						mask[n] = a
					else:
						mask[n] = -b
					n += 1
			
			n = 0
			for j in range(CHUNK_SIZE):
				var i = 0
				while i < CHUNK_SIZE:
					var c = mask[n]
					if c != 0:
						var w = 1
						while i + w < CHUNK_SIZE and mask[n + w] == c:
							w += 1
						var h = 1
						var done = false
						while j + h < CHUNK_SIZE:
							for k in range(w):
								if mask[n + k + h * CHUNK_SIZE] != c:
									done = true
									break
							if done:
								break
							h += 1
						
						x[u] = i
						x[v] = j
						var du = [0, 0, 0]
						var dv = [0, 0, 0]
						du[u] = w
						dv[v] = h
						
						var pos = Vector3(x[0], x[1], x[2]) + Vector3(q[0], q[1], q[2])
						var normal = Vector3(q[0], q[1], q[2]) if c > 0 else Vector3(-q[0], -q[1], -q[2])
						_add_greedy_quad(st, pos, Vector3(du[0], du[1], du[2]), Vector3(dv[0], dv[1], dv[2]), c, normal)
						
						for l in range(h):
							for k in range(w):
								mask[n + k + l * CHUNK_SIZE] = 0
						i += w
						n += w
					else:
						i += 1
						n += 1

	st.set_material(shared_material)
	var array_mesh = st.commit()
	mesh_instance.mesh = array_mesh
	
	if array_mesh.get_surface_count() > 0:
		collision_shape.shape = array_mesh.create_trimesh_shape()
	else:
		collision_shape.shape = null

func _add_greedy_quad(st: SurfaceTool, p: Vector3, du: Vector3, dv: Vector3, c: int, normal: Vector3):
	var val = abs(c)
	var col_idx = clampi(val & 0xFF, 1, PALETTE.size() - 1)
	var tex_idx = clampi((val >> 8) & 0xFF, 0, 7)
	
	var color = PALETTE[col_idx]
	if abs(normal.x) > 0.5:
		color = color.darkened(0.14)
	elif abs(normal.z) > 0.5:
		color = color.darkened(0.07)
	elif normal.y < -0.5:
		color = color.darkened(0.28)

	st.set_color(color)
	st.set_normal(normal)
	
	# Map into the 1/8th horizontal slot of our pixel texture atlas
	var u0 = (float(tex_idx) + 0.08) / 8.0
	var u1 = (float(tex_idx) + 0.92) / 8.0
	var uv0 = Vector2(u0, 0.92)
	var uv1 = Vector2(u1, 0.92)
	var uv2 = Vector2(u1, 0.08)
	var uv3 = Vector2(u0, 0.08)
	
	var v0 = p
	var v1 = p + du
	var v2 = p + du + dv
	var v3 = p + dv
	
	if c > 0:
		st.set_uv(uv0); st.add_vertex(v0)
		st.set_uv(uv2); st.add_vertex(v2)
		st.set_uv(uv1); st.add_vertex(v1)
		st.set_uv(uv0); st.add_vertex(v0)
		st.set_uv(uv3); st.add_vertex(v3)
		st.set_uv(uv2); st.add_vertex(v2)
	else:
		st.set_uv(uv0); st.add_vertex(v0)
		st.set_uv(uv1); st.add_vertex(v1)
		st.set_uv(uv2); st.add_vertex(v2)
		st.set_uv(uv0); st.add_vertex(v0)
		st.set_uv(uv2); st.add_vertex(v2)
		st.set_uv(uv3); st.add_vertex(v3)