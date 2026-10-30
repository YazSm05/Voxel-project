class_name VoxelChunk
extends StaticBody3D

const CHUNK_SIZE = 16
var voxels = [] # Tableau 3D aplati : CHUNK_SIZE^3 (0 = vide, >0 = ID couleur)
var mesh_instance: MeshInstance3D
var collision_shape: CollisionShape3D

const PALETTE = {
	1: Color("#6ab04c"), # Herbe
	2: Color("#22a6b3"), # Cristal Glace
	3: Color("#eb4d4b"), # Magma
	4: Color("#f9ca24"), # Sable d'or
	5: Color("#95afc0")  # Pierre
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

# Algorithme de Greedy Meshing sur les 3 axes (X, Y, Z) et 2 directions (avant/arrière)
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
						mask[n] = a # Face positive
					else:
						mask[n] = -b # Face négative
					n += 1
			
			# Balayage Greedy 2D sur le masque
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
						_add_greedy_quad(st, pos, Vector3(du[0], du[1], du[2]), Vector3(dv[0], dv[1], dv[2]), c)
						
						for l in range(h):
							for k in range(w):
								mask[n + k + l * CHUNK_SIZE] = 0
						i += w
						n += w
					else:
						i += 1
						n += 1

	st.generate_normals()
	var mat = StandardMaterial3D.new()
	mat.vertex_color_use_as_albedo = true
	mat.roughness = 0.85
	st.set_material(mat)
	
	var array_mesh = st.commit()
	mesh_instance.mesh = array_mesh
	
	# Mise à jour de la physique pour le Mode Exploration
	if array_mesh.get_surface_count() > 0:
		collision_shape.shape = array_mesh.create_trimesh_shape()
	else:
		collision_shape.shape = null

func _add_greedy_quad(st: SurfaceTool, p: Vector3, du: Vector3, dv: Vector3, c: int):
	var color = PALETTE.get(abs(c), Color.WHITE)
	st.set_color(color)
	var v0 = p
	var v1 = p + du
	var v2 = p + du + dv
	var v3 = p + dv
	
	if c > 0:
		st.add_vertex(v0); st.add_vertex(v1); st.add_vertex(v2)
		st.add_vertex(v0); st.add_vertex(v2); st.add_vertex(v3)
	else:
		st.add_vertex(v0); st.add_vertex(v2); st.add_vertex(v1)
		st.add_vertex(v0); st.add_vertex(v3); st.add_vertex(v2)