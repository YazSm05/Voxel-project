extends Node3D

var chunks = {}
var is_explore_mode = false

@onready var editor_camera: Camera3D = $EditorCamera
@onready var player: CharacterBody3D = $Player

func _ready():
	generate_island_preset()
	set_game_mode(false)

func _unhandled_input(event):
	if event.is_action_pressed("ui_focus_next"): # Touche TAB
		set_game_mode(!is_explore_mode)

func set_game_mode(explore: bool):
	is_explore_mode = explore
	editor_camera.current = !explore
	editor_camera.set_process_unhandled_input(!explore)
	player.visible = explore
	player.set_physics_process(explore)
	player.get_node("Camera3D").current = explore
	if explore:
		player.global_position = Vector3(16, 14, 16) # Téléporte au-dessus de l'île
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
	else:
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE

func get_or_create_chunk(cx: int, cy: int, cz: int) -> VoxelChunk:
	var key = Vector3i(cx, cy, cz)
	if not chunks.has(key):
		var chunk = VoxelChunk.new()
		chunk.position = Vector3(key * VoxelChunk.CHUNK_SIZE)
		add_child(chunk)
		chunks[key] = chunk
	return chunks[key]

func set_world_voxel(wx: int, wy: int, wz: int, id: int, rebuild := true):
	var cx = floori(float(wx) / VoxelChunk.CHUNK_SIZE)
	var cy = floori(float(wy) / VoxelChunk.CHUNK_SIZE)
	var cz = floori(float(wz) / VoxelChunk.CHUNK_SIZE)
	var lx = posmod(wx, VoxelChunk.CHUNK_SIZE)
	var ly = posmod(wy, VoxelChunk.CHUNK_SIZE)
	var lz = posmod(wz, VoxelChunk.CHUNK_SIZE)
	
	var chunk = get_or_create_chunk(cx, cy, cz)
	chunk.set_voxel(lx, ly, lz, id)
	if rebuild:
		chunk.rebuild_mesh()

func generate_island_preset():
	for x in range(32):
		for z in range(32):
			for y in range(4, 8):
				var block_id = 1 if y == 7 else 5
				set_world_voxel(x, y, z, block_id, false)
	for chunk in chunks.values():
		chunk.rebuild_mesh()