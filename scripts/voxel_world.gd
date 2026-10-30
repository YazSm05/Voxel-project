extends Node3D

const VoxelChunkScript = preload("res://scripts/voxel_chunk.gd")
const WORLD_SIZE = 32

var chunks = {}
var world_data = {} # Vector3i -> block_id
var is_explore_mode = false
var current_tool = "add" # "add", "erase", "paint", "pillar"
var selected_block_id = 1

var minimap_img: Image
var minimap_tex: ImageTexture
var status_label: Label
var mode_btn: Button

@onready var editor_camera: Camera3D = $EditorCamera
@onready var player: CharacterBody3D = $Player

func _ready():
	_build_workshop_ui()
	generate_sandbox_island()
	set_game_mode(false)

func _unhandled_input(event):
	if event is InputEventKey and event.pressed and event.keycode == KEY_TAB:
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
		player.global_position = Vector3(16, 18, 16)
		player.velocity = Vector3.ZERO
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
		if mode_btn: mode_btn.text = "Mode: EXPLORATION (TAB to Edit)"
	else:
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
		if mode_btn: mode_btn.text = "Play / Explore (TAB)"

func get_or_create_chunk(cx: int, cy: int, cz: int):
	var key = Vector3i(cx, cy, cz)
	if not chunks.has(key):
		var chunk = VoxelChunkScript.new()
		chunk.position = Vector3(key * 16)
		add_child(chunk)
		chunks[key] = chunk
	return chunks[key]

func set_world_voxel(wx: int, wy: int, wz: int, id: int, rebuild := true):
	if wx < 0 or wx >= WORLD_SIZE or wy < 0 or wy >= WORLD_SIZE or wz < 0 or wz >= WORLD_SIZE:
		return
	var pos = Vector3i(wx, wy, wz)
	if id == 0:
		world_data.erase(pos)
	else:
		world_data[pos] = id

	var cx = floori(float(wx) / 16.0)
	var cy = floori(float(wy) / 16.0)
	var cz = floori(float(wz) / 16.0)
	var chunk = get_or_create_chunk(cx, cy, cz)
	chunk.set_voxel(posmod(wx, 16), posmod(wy, 16), posmod(wz, 16), id)
	if rebuild:
		chunk.rebuild_mesh()
		_update_minimap()
		_update_status()

func apply_tool_at(wx: int, wy: int, wz: int, normal: Vector3):
	if current_tool == "erase":
		var p = Vector3(wx, wy, wz) - normal * 0.5
		set_world_voxel(floori(p.x), floori(p.y), floori(p.z), 0)
	elif current_tool == "paint":
		var p = Vector3(wx, wy, wz) - normal * 0.5
		var tp = Vector3i(floori(p.x), floori(p.y), floori(p.z))
		if world_data.has(tp):
			set_world_voxel(tp.x, tp.y, tp.z, selected_block_id)
	elif current_tool == "pillar":
		var p = Vector3(wx, wy, wz) + normal * 0.5
		for h in range(4):
			set_world_voxel(floori(p.x), floori(p.y) + h, floori(p.z), selected_block_id, h == 3)
	else: # "add"
		var p = Vector3(wx, wy, wz) + normal * 0.5
		set_world_voxel(floori(p.x), floori(p.y), floori(p.z), selected_block_id)

func generate_sandbox_island():
	world_data.clear()
	for chunk in chunks.values():
		chunk.voxels.fill(0)

	# 1. Hanging Terracotta Cliffs & Four Biomes Surface
	for x in range(2, 30):
		for z in range(2, 30):
			var dist = Vector2(x - 16, z - 16).length()
			var depth = int(clamp(10.0 - dist * 0.45 + sin(x * 0.7) * 1.5 + cos(z * 0.7) * 1.5, 2.0, 9.0))
			for y in range(10 - depth, 11):
				var bid = 6 # Terracotta Cliff
				if y == 10:
					if x < 16 and z < 16: bid = 2 # Ice Citadel Biome
					elif x >= 16 and z < 16: bid = 7 # Forest Biome
					elif x < 16 and z >= 16: bid = 3 # Volcanic Magma Biome
					else: bid = 4 # Golden Desert Biome
				elif y == 9:
					bid = 1 # Grass Rim
				set_world_voxel(x, y, z, bid, false)

	# 2. Ice Citadel Spires (North-West)
	for y in range(11, 18):
		set_world_voxel(8, y, 8, 2, false)
		set_world_voxel(9, y, 8, 2, false)
		if y < 15:
			set_world_voxel(7, y, 9, 2, false)
			set_world_voxel(10, y, 9, 2, false)

	# 3. Center Obsidian Monolith
	for x in range(14, 18):
		for z in range(14, 18):
			for y in range(11, 15):
				set_world_voxel(x, y, z, 8, false)

	# 4. Desert Pyramid (South-East)
	for l in range(4):
		for x in range(20 + l, 27 - l):
			for z in range(20 + l, 27 - l):
				set_world_voxel(x, 11 + l, z, 4, false)

	# 5. Forest Trees (North-East)
	for t in [Vector2i(22, 8), Vector2i(25, 11), Vector2i(20, 12)]:
		for y in range(11, 14):
			set_world_voxel(t.x, y, t.y, 6, false)
		for lx in range(t.x - 1, t.x + 2):
			for lz in range(t.y - 1, t.y + 2):
				set_world_voxel(lx, 14, lz, 1, false)
		set_world_voxel(t.x, 15, t.y, 1, false)

	_rebuild_all()

func _rebuild_all():
	for chunk in chunks.values():
		chunk.rebuild_mesh()
	_update_minimap()
	_update_status()

func save_build():
	var save_array = []
	for pos in world_data.keys():
		save_array.append([pos.x, pos.y, pos.z, world_data[pos]])
	var file = FileAccess.open("user://sandbox_build.json", FileAccess.WRITE)
	if file:
		file.store_string(JSON.stringify(save_array))
		status_label.text = "Saved build! (" + str(world_data.size()) + " cubes)"

func load_build():
	if not FileAccess.file_exists("user://sandbox_build.json"):
		status_label.text = "No saved build found yet!"
		return
	var file = FileAccess.open("user://sandbox_build.json", FileAccess.READ)
	var data = JSON.parse_string(file.get_as_text())
	if typeof(data) == TYPE_ARRAY:
		world_data.clear()
		for chunk in chunks.values():
			chunk.voxels.fill(0)
		for item in data:
			set_world_voxel(int(item[0]), int(item[1]), int(item[2]), int(item[3]), false)
		_rebuild_all()
		status_label.text = "Loaded build! (" + str(world_data.size()) + " cubes)"

func _update_minimap():
	if not minimap_img: return
	minimap_img.fill(Color("#0c1926"))
	for x in range(WORLD_SIZE):
		for z in range(WORLD_SIZE):
			for y in range(WORLD_SIZE - 1, -1, -1):
				var pos = Vector3i(x, y, z)
				if world_data.has(pos):
					var c = VoxelChunkScript.PALETTE.get(world_data[pos], Color.WHITE)
					minimap_img.set_pixel(x, z, c)
					break
	minimap_tex.update(minimap_img)

func _update_status():
	if status_label:
		status_label.text = "Voxels: " + str(world_data.size()) + " | Tool: " + current_tool.to_upper()

func _build_workshop_ui():
	var canvas = CanvasLayer.new()
	add_child(canvas)

	# Top Bar
	var top_bar = PanelContainer.new()
	top_bar.set_anchors_preset(Control.PRESET_TOP_WIDE)
	top_bar.offset_bottom = 48
	canvas.add_child(top_bar)

	var top_hbox = HBoxContainer.new()
	top_hbox.add_theme_constant_override("separation", 12)
	top_bar.add_child(top_hbox)

	var title = Label.new()
	title.text = "  THE SANDBOX WORKSHOP (GODOT 4)  "
	title.add_theme_color_override("font_color", Color("#38c6d9"))
	top_hbox.add_child(title)

	mode_btn = Button.new()
	mode_btn.text = "Play / Explore (TAB)"
	mode_btn.pressed.connect(func(): set_game_mode(!is_explore_mode))
	top_hbox.add_child(mode_btn)

	var reset_btn = Button.new()
	reset_btn.text = "4-Biome Island"
	reset_btn.pressed.connect(generate_sandbox_island)
	top_hbox.add_child(reset_btn)

	var save_btn = Button.new()
	save_btn.text = "Save Build"
	save_btn.pressed.connect(save_build)
	top_hbox.add_child(save_btn)

	var load_btn = Button.new()
	load_btn.text = "Load Build"
	load_btn.pressed.connect(load_build)
	top_hbox.add_child(load_btn)

	status_label = Label.new()
	status_label.text = "Ready"
	top_hbox.add_child(status_label)

	# Left Tool Dock
	var left_panel = PanelContainer.new()
	left_panel.position = Vector2(12, 64)
	canvas.add_child(left_panel)

	var left_vbox = VBoxContainer.new()
	left_panel.add_child(left_vbox)

	for t in [["+ Add Cube", "add"], ["- Erase Cube", "erase"], ["Paint Voxel", "paint"], ["4x Pillar", "pillar"]]:
		var b = Button.new()
		b.text = t[0]
		b.pressed.connect(func():
			current_tool = t[1]
			_update_status()
		)
		left_vbox.add_child(b)

	# Bottom Block Palette
	var bottom_panel = PanelContainer.new()
	bottom_panel.set_anchors_preset(Control.PRESET_BOTTOM_WIDE)
	bottom_panel.offset_top = -54
	canvas.add_child(bottom_panel)

	var bot_hbox = HBoxContainer.new()
	bot_hbox.alignment = BoxContainer.ALIGNMENT_CENTER
	bot_hbox.add_theme_constant_override("separation", 8)
	bottom_panel.add_child(bot_hbox)

	var names = {1:"1:Grass", 2:"2:Ice", 3:"3:Magma", 4:"4:Sand", 5:"5:Stone", 6:"6:Cliff", 7:"7:Forest", 8:"8:Obsidian"}
	for id in names.keys():
		var btn = Button.new()
		btn.text = names[id]
		btn.modulate = VoxelChunkScript.PALETTE[id].lightened(0.2)
		btn.pressed.connect(func(): selected_block_id = id)
		bot_hbox.add_child(btn)

	# Bottom-Left Live 2D Minimap
	var map_panel = PanelContainer.new()
	map_panel.position = Vector2(12, 240)
	canvas.add_child(map_panel)

	minimap_img = Image.create(WORLD_SIZE, WORLD_SIZE, false, Image.FORMAT_RGBA8)
	minimap_tex = ImageTexture.create_from_image(minimap_img)
	var map_rect = TextureRect.new()
	map_rect.texture = minimap_tex
	map_rect.custom_minimum_size = Vector2(128, 128)
	map_rect.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	map_rect.expand_mode = TextureRect.EXPAND_FIT_WIDTH_PROPORTIONAL
	map_panel.add_child(map_rect)