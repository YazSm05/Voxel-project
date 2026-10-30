extends Node3D

const VoxelChunkScript = preload("res://scripts/voxel_chunk.gd")

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
	editor_camera.set_process(!explore)
	editor_camera.set_process_unhandled_input(!explore)
	player.visible = explore
	player.set_physics_process(explore)
	var player_cam = player.get_node_or_null("Camera3D")
	if player_cam:
		player_cam.current = explore
	if explore:
		player.global_position = Vector3(16, 14, 16)
		player.velocity = Vector3.ZERO
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
	else:
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE

func get_or_create_chunk(cx: int, cy: int, cz: int):
	var key = Vector3i(cx, cy, cz)
	if not chunks.has(key):
		var chunk = VoxelChunkScript.new()
		chunk.position = Vector3(key * 16)
		add_child(chunk)
		chunks[key] = chunk
	return chunks[key]

func set_world_voxel(wx: int, wy: int, wz: int, id: int, rebuild := true):
	var cx = floori(float(wx) / 16.0)
	var cy = floori(float(wy) / 16.0)
	var cz = floori(float(wz) / 16.0)
	var lx = posmod(wx, 16)
	var ly = posmod(wy, 16)
	var lz = posmod(wz, 16)
	
	var chunk = get_or_create_chunk(cx, cy, cz)
	chunk.set_voxel(lx, ly, lz, id)
	if rebuild:
		chunk.rebuild_mesh()

func generate_island_preset():
	for x in range(4, 28):
		for z in range(4, 28):
			for y in range(4, 8):
				var block_id = 5 # Pierre
				if y == 7:
					if x < 16 and z < 16:
						block_id = 2 # Cristal Glace
					elif x >= 16 and z < 16:
						block_id = 3 # Magma
					elif x < 16 and z >= 16:
						block_id = 4 # Désert d'or
					else:
						block_id = 1 # Herbe
				set_world_voxel(x, y, z, block_id, false)
	
	# Petite tour centrale
	for y in range(8, 13):
		set_world_voxel(15, y, 15, 2, false)
		set_world_voxel(16, y, 15, 2, false)
		set_world_voxel(15, y, 16, 2, false)
		set_world_voxel(16, y, 16, 2, false)

	for chunk in chunks.values():
		chunk.rebuild_mesh()