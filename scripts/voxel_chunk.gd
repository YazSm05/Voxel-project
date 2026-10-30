class_name VoxelChunk
extends StaticBody3D

const CHUNK_SIZE = 16
var voxels = []
var mesh_instance: MeshInstance3D
var collision_shape: CollisionShape3D

const PALETTE = {
	1: Color("#6ab04c"), # Grass Top
	2: Color("#38c6d9"), # Ice Crystal
	3: Color("#ff5232"), # Magma Core
	4: Color("#f6d365"), # Desert Sand
	5: Color("#7f8c8d"), # Stone Brick
	6: Color("#9b6b4b"), # Terracotta Cliff
	7: Color("#3d6e38"), # Forest Leaves
	8: Color("#2f3640")  # Obsidian Dark
}

func _init():
	voxels.resize(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE)
	voxels.fill(0)
	mesh_instance = MeshInstance3D.new()
	collision_shape = CollisionShape3D.new()
	add_child(mesh_instance)
	add_child(collision_shape)

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

	var mat = StandardMaterial3D.new()
	mat.vertex_color_use_as_albedo = true
	mat.roughness = 0.9
	st.set_material(mat)
	
	var array_mesh = st.commit()
	mesh_instance.mesh = array_mesh
	
	if array_mesh.get_surface_count() > 0:
		collision_shape.shape = array_mesh.create_trimesh_shape()
	else:
		collision_shape.shape = null

func _add_greedy_quad(st: SurfaceTool, p: Vector3, du: Vector3, dv: Vector3, c: int, normal: Vector3):
	var color = PALETTE.get(abs(c), Color.WHITE)
	# Subtle face shading so cubes stand out clearly
	if abs(normal.x) > 0.5:
		color = color.darkened(0.12)
	elif abs(normal.z) > 0.5:
		color = color.darkened(0.06)
	elif normal.y < -0.5:
		color = color.darkened(0.25)

	st.set_color(color)
	st.set_normal(normal)
	
	var v0 = p
	var v1 = p + du
	var v2 = p + du + dv
	var v3 = p + dv
	
	if c > 0:
		st.add_vertex(v0); st.add_vertex(v2); st.add_vertex(v1)
		st.add_vertex(v0); st.add_vertex(v3); st.add_vertex(v2)
	else:
		st.add_vertex(v0); st.add_vertex(v1); st.add_vertex(v2)
		st.add_vertex(v0); st.add_vertex(v2); st.add_vertex(v3)