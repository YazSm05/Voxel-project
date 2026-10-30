extends Node3D

const VoxelChunkScript = preload("res://scripts/voxel_chunk.gd")
const WORLD_SIZE = 32

var chunks = {}
var world_data = {} # Vector3i -> packed (col_idx + (tex_idx << 8))
var is_explore_mode = false

var current_tool = "add" # add, erase, paint, box, column, eyedrop
var selected_col_idx = 1
var selected_tex_idx = 0
var brush_size = 1
var mirror_x = false

var tool_buttons = {}
var tex_buttons = {}
var brush_buttons = {}
var mirror_btn: Button
var count_label: Label
var coord_label: Label
var hex_label: Label
var tex_name_label: Label
var mode_btn: Button
var minimap_img: Image
var minimap_tex: ImageTexture

const TEX_NAMES = ["Grass Block", "Solid Matte", "Ice Crystal", "Magma Core", "Stone Brick", "Wood Planks", "Desert Sand", "Forest Leaf"]
const TEX_SHORT = ["Grass", "Solid", "Ice", "Magma", "Stone", "Wood", "Sand", "Leaf"]

@onready var editor_camera: Camera3D = $EditorCamera
@onready var player: CharacterBody3D = $Player

func _ready():
	_build_sandbox_hud()
	generate_sandbox_island()
	set_game_mode(false)

func _unhandled_input(event):
	if event is InputEventKey and event.pressed and event.keycode == KEY_TAB:
		set_game_mode(!is_explore_mode)

func pack_voxel(col_idx: int, tex_idx: int) -> int:
	return (col_idx & 0xFF) | ((tex_idx & 0xFF) << 8)

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
		player.global_position = Vector3(16, 20, 16)
		player.velocity = Vector3.ZERO
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
		if mode_btn: mode_btn.text = "■ Stop Explore (TAB)"
	else:
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
		if mode_btn: mode_btn.text = "▶ Play / Explore"

func get_or_create_chunk(cx: int, cy: int, cz: int):
	var key = Vector3i(cx, cy, cz)
	if not chunks.has(key):
		var chunk = VoxelChunkScript.new()
		chunk.position = Vector3(key * 16)
		add_child(chunk)
		chunks[key] = chunk
	return chunks[key]

func set_world_voxel(wx: int, wy: int, wz: int, val: int, rebuild := true):
	if wx < 0 or wx >= WORLD_SIZE or wy < 0 or wy >= WORLD_SIZE or wz < 0 or wz >= WORLD_SIZE:
		return
	var pos = Vector3i(wx, wy, wz)
	if val == 0:
		world_data.erase(pos)
	else:
		world_data[pos] = val

	var cx = floori(float(wx) / 16.0)
	var cy = floori(float(wy) / 16.0)
	var cz = floori(float(wz) / 16.0)
	var chunk = get_or_create_chunk(cx, cy, cz)
	chunk.set_voxel(posmod(wx, 16), posmod(wy, 16), posmod(wz, 16), val)
	if rebuild:
		chunk.rebuild_mesh()
		_update_minimap()
		_update_hud_labels()

func _set_with_mirror(wx: int, wy: int, wz: int, val: int, rebuild := false):
	set_world_voxel(wx, wy, wz, val, rebuild)
	if mirror_x:
		var mx = WORLD_SIZE - 1 - wx
		set_world_voxel(mx, wy, wz, val, rebuild)

func apply_tool_at(hit_pos: Vector3, normal: Vector3):
	var inside_p = hit_pos - normal * 0.5
	var outside_p = hit_pos + normal * 0.5
	var ix = floori(inside_p.x); var iy = floori(inside_p.y); var iz = floori(inside_p.z)
	var ox = floori(outside_p.x); var oy = floori(outside_p.y); var oz = floori(outside_p.z)

	if coord_label:
		coord_label.text = str(ox - 16) + ", " + str(oy - 10) + ", " + str(oz - 16)

	var packed = pack_voxel(selected_col_idx, selected_tex_idx)
	var r = brush_size - 1

	if current_tool == "eyedrop":
		var p = Vector3i(ix, iy, iz)
		if world_data.has(p):
			var v = world_data[p]
			_select_color(v & 0xFF)
			_select_texture((v >> 8) & 0xFF)
		return
	elif current_tool == "erase":
		for dx in range(-r, r + 1):
			for dy in range(-r, r + 1):
				for dz in range(-r, r + 1):
					_set_with_mirror(ix + dx, iy + dy, iz + dz, 0, false)
	elif current_tool == "paint":
		for dx in range(-r, r + 1):
			for dy in range(-r, r + 1):
				for dz in range(-r, r + 1):
					var tp = Vector3i(ix + dx, iy + dy, iz + dz)
					if world_data.has(tp):
						_set_with_mirror(tp.x, tp.y, tp.z, packed, false)
	elif current_tool == "column":
		for h in range(4):
			_set_with_mirror(ox, oy + h, oz, packed, false)
	elif current_tool == "box":
		for dx in range(-1, 2):
			for dz in range(-1, 2):
				_set_with_mirror(ox + dx, oy, oz + dz, packed, false)
	else: # "add"
		for dx in range(-r, r + 1):
			for dy in range(-r, r + 1):
				for dz in range(-r, r + 1):
					_set_with_mirror(ox + dx, oy + dy, oz + dz, packed, false)

	_rebuild_all()

func generate_sandbox_island():
	world_data.clear()
	for chunk in chunks.values():
		chunk.voxels.fill(0)

	# 1. Floating Terracotta Island + Hanging Stalactites + 4 Biomes
	for x in range(4, 28):
		for z in range(4, 28):
			var dist = Vector2(x - 15.5, z - 15.5).length()
			var wave = int(sin(x * 0.8) * 1.8 + cos(z * 0.8) * 1.8)
			var bottom_y = clampi(int(dist * 0.48) + 2 + wave, 2, 9)
			for y in range(bottom_y, 11):
				var col = 5 # Terracotta cliff
				var tex = 4 # Stone/Cliff
				if y == 9 and (x == 4 or x == 27 or z == 4 or z == 27):
					col = 2; tex = 0 # Hanging green moss edge
				elif y == 10:
					if x < 16 and z < 16:
						# NW: Frost & Crystal Biome (white snow + cyan grid)
						col = 10 if (x + z) % 2 == 0 else 9
						tex = 2
					elif x >= 16 and z < 16:
						# NE: Lush Forest Biome
						col = 1 if (x + z) % 3 != 0 else 2
						tex = 0
					elif x < 16 and z >= 16:
						# SW: Volcanic & Obsidian Crater
						col = 28 if (x * z) % 5 != 0 else 25
						tex = 3 if col == 25 else 4
					else:
						# SE: Golden Desert Biome with dark checkered border
						if (x == 17 or x == 26 or z == 17 or z == 26) and (x + z) % 2 == 0:
							col = 29; tex = 4
						else:
							col = 17; tex = 6
				set_world_voxel(x, y, z, pack_voxel(col, tex), false)

	# 2. Detached Floating Rock Mini-Islands (like reference image)
	for rock in [Vector3i(1, 5, 10), Vector3i(2, 4, 22), Vector3i(10, 3, 29), Vector3i(29, 5, 19)]:
		for rx in range(2):
			for rz in range(2):
				set_world_voxel(rock.x + rx, rock.y, rock.z + rz, pack_voxel(5, 4), false)
				set_world_voxel(rock.x + rx, rock.y + 1, rock.z + rz, pack_voxel(2, 0), false)

	# 3. NW Ice Crystal Citadel Spires
	var spires = [[8, 8, 6], [9, 8, 8], [10, 9, 7], [8, 10, 5], [11, 7, 5], [7, 7, 4]]
	for s in spires:
		for y in range(11, 11 + s[2]):
			set_world_voxel(s[0], y, s[1], pack_voxel(11, 2), false)

	# 4. SW stepped Terracotta Volcano with Glowing Magma Core
	for l in range(3):
		for x in range(6 + l, 13 - l):
			for z in range(18 + l, 25 - l):
				set_world_voxel(x, 11 + l, z, pack_voxel(6, 4), false)
	set_world_voxel(9, 14, 21, pack_voxel(25, 3), false)
	set_world_voxel(8, 13, 21, pack_voxel(26, 3), false)

	# 5. Center Dark Obsidian Monolith
	for y in range(11, 17):
		set_world_voxel(15, y, 15, pack_voxel(29, 4), false)
		set_world_voxel(16, y, 15, pack_voxel(29, 4), false)
		if y in [13, 14]:
			set_world_voxel(14, y, 15, pack_voxel(29, 4), false)
			set_world_voxel(17, y, 15, pack_voxel(29, 4), false)

	# 6. SE Stepped Golden Pyramid & Watchtower
	for l in range(4):
		for x in range(18 + l, 26 - l):
			for z in range(18 + l, 26 - l):
				set_world_voxel(x, 11 + l, z, pack_voxel(18 if l % 2 == 0 else 17, 6), false)
	for y in range(11, 15):
		set_world_voxel(17, y, 18, pack_voxel(28, 4), false)
		set_world_voxel(18, y, 17, pack_voxel(28, 4), false)

	# 7. NE Forest Sanctuary Plataforma & Trees
	for x in range(19, 26):
		for z in range(6, 13):
			set_world_voxel(x, 11, z, pack_voxel(5, 5), false)
			if x in [20, 24] and z in [7, 11]:
				for ty in range(12, 15):
					set_world_voxel(x, ty, z, pack_voxel(6, 5), false)
				for lx in range(x - 1, x + 2):
					for lz in range(z - 1, z + 2):
						set_world_voxel(lx, 15, lz, pack_voxel(1, 7), false)
				set_world_voxel(x, 16, z, pack_voxel(4, 7), false)

	_rebuild_all()

func _rebuild_all():
	for chunk in chunks.values():
		chunk.rebuild_mesh()
	_update_minimap()
	_update_hud_labels()

func _make_style(bg: Color, border: Color, bw := 1, radius := 6) -> StyleBoxFlat:
	var s = StyleBoxFlat.new()
	s.bg_color = bg
	s.border_color = border
	s.set_border_width_all(bw)
	s.set_corner_radius_all(radius)
	s.content_margin_left = 10; s.content_margin_right = 10
	s.content_margin_top = 8; s.content_margin_bottom = 8
	return s

func _style_btn(b: Button, active := false):
	var normal_s = _make_style(Color("#1589b8") if active else Color("#102538"), Color("#38e2ff") if active else Color("#1e4460"), 1, 5)
	var hover_s = _make_style(Color("#1ba3d9") if active else Color("#183752"), Color("#38e2ff"), 1, 5)
	b.add_theme_stylebox_override("normal", normal_s)
	b.add_theme_stylebox_override("hover", hover_s)
	b.add_theme_stylebox_override("pressed", hover_s)
	b.add_theme_color_override("font_color", Color.WHITE)
	b.add_theme_font_size_override("font_size", 12)

func _select_tool(t_id: String):
	current_tool = t_id
	for k in tool_buttons.keys():
		_style_btn(tool_buttons[k], k == t_id)

func _select_texture(t_idx: int):
	selected_tex_idx = t_idx
	if tex_name_label:
		tex_name_label.text = TEX_NAMES[t_idx]
	for k in tex_buttons.keys():
		_style_btn(tex_buttons[k], k == t_idx)

func _select_color(c_idx: int):
	selected_col_idx = c_idx
	if hex_label:
		hex_label.text = "#" + VoxelChunkScript.PALETTE[c_idx].to_html(false).to_upper()

func _select_brush(b_size: int):
	brush_size = b_size
	for k in brush_buttons.keys():
		_style_btn(brush_buttons[k], k == b_size)

func _update_hud_labels():
	if count_label:
		count_label.text = str(world_data.size()) + " Cubes"

func _update_minimap():
	if not minimap_img: return
	minimap_img.fill(Color("#081824"))
	for x in range(WORLD_SIZE):
		for z in range(WORLD_SIZE):
			for y in range(WORLD_SIZE - 1, -1, -1):
				var pos = Vector3i(x, y, z)
				if world_data.has(pos):
					var c_idx = world_data[pos] & 0xFF
					minimap_img.set_pixel(x, z, VoxelChunkScript.PALETTE[c_idx])
					break
	minimap_tex.update(minimap_img)

func save_build():
	var arr = []
	for pos in world_data.keys():
		arr.append([pos.x, pos.y, pos.z, world_data[pos]])
	var f = FileAccess.open("user://sandbox_island.json", FileAccess.WRITE)
	if f:
		f.store_string(JSON.stringify(arr))
		if count_label: count_label.text = "Saved (" + str(world_data.size()) + ")"

func load_build():
	if not FileAccess.file_exists("user://sandbox_island.json"): return
	var f = FileAccess.open("user://sandbox_island.json", FileAccess.READ)
	var data = JSON.parse_string(f.get_as_text())
	if typeof(data) == TYPE_ARRAY:
		world_data.clear()
		for chunk in chunks.values(): chunk.voxels.fill(0)
		for item in data:
			set_world_voxel(int(item[0]), int(item[1]), int(item[2]), int(item[3]), false)
		_rebuild_all()

func _build_sandbox_hud():
	var canvas = CanvasLayer.new()
	add_child(canvas)
	var panel_style = _make_style(Color(0.04, 0.11, 0.17, 0.92), Color("#1e4968"), 1, 8)

	# 1. TOP-LEFT BRAND BAR ("♦ SANDBOX ♦ | Four-Biome Floating Island")
	var top_left = PanelContainer.new()
	top_left.position = Vector2(14, 10)
	top_left.add_theme_stylebox_override("panel", panel_style)
	canvas.add_child(top_left)
	var tl_hb = HBoxContainer.new()
	tl_hb.add_theme_constant_override("separation", 12)
	top_left.add_child(tl_hb)
	var logo = Label.new()
	logo.text = "♦ SANDBOX ♦"
	logo.add_theme_color_override("font_color", Color("#38e2ff"))
	logo.add_theme_font_size_override("font_size", 15)
	tl_hb.add_child(logo)
	var world_title = Button.new()
	world_title.text = "Four-Biome Floating Island"
	_style_btn(world_title, false)
	world_title.pressed.connect(generate_sandbox_island)
	tl_hb.add_child(world_title)

	# 2. TOP-CENTER CAMERA & CLOUD DOCK
	var top_center = PanelContainer.new()
	top_center.position = Vector2(265, 58)
	top_center.add_theme_stylebox_override("panel", panel_style)
	canvas.add_child(top_center)
	var tc_vb = VBoxContainer.new()
	tc_vb.add_theme_constant_override("separation", 6)
	top_center.add_child(tc_vb)

	var cam_hb = HBoxContainer.new()
	cam_hb.add_theme_constant_override("separation", 6)
	tc_vb.add_child(cam_hb)
	for view_info in [["FRONT", 0.0, -0.45], ["SIDE", 1.57, -0.45], ["ISO", 0.78, -0.55], ["ORTHO", 0.78, -0.6]]:
		var vb = Button.new()
		vb.text = view_info[0]
		_style_btn(vb, view_info[0] == "ORTHO")
		vb.pressed.connect(func():
			if view_info[0] == "ORTHO":
				editor_camera.toggle_ortho()
			else:
				editor_camera.set_angle(view_info[1], view_info[2])
		)
		cam_hb.add_child(vb)

	var pub_hb = HBoxContainer.new()
	pub_hb.add_theme_constant_override("separation", 6)
	tc_vb.add_child(pub_hb)
	mode_btn = Button.new()
	mode_btn.text = "▶ Play / Explore"
	_style_btn(mode_btn, false)
	mode_btn.pressed.connect(func(): set_game_mode(!is_explore_mode))
	pub_hb.add_child(mode_btn)

	var save_b = Button.new()
	save_b.text = "💾 Save"
	_style_btn(save_b, false)
	save_b.pressed.connect(save_build)
	pub_hb.add_child(save_b)

	var pub_b = Button.new()
	pub_b.text = "☁ Publish"
	_style_btn(pub_b, true)
	pub_b.pressed.connect(save_build)
	pub_hb.add_child(pub_b)

	# 3. LEFT DOCK: VOXEL TOOLS (2-Column Grid + Brush Size + Mirror X)
	var left_dock = PanelContainer.new()
	left_dock.position = Vector2(14, 58)
	left_dock.custom_minimum_size = Vector2(236, 0)
	left_dock.add_theme_stylebox_override("panel", panel_style)
	canvas.add_child(left_dock)

	var l_vb = VBoxContainer.new()
	l_vb.add_theme_constant_override("separation", 10)
	left_dock.add_child(l_vb)

	var l_head = HBoxContainer.new()
	l_vb.add_child(l_head)
	var l_title = Label.new()
	l_title.text = "VOXEL TOOLS"
	l_title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	l_title.add_theme_color_override("font_color", Color("#38e2ff"))
	l_title.add_theme_font_size_override("font_size", 13)
	l_head.add_child(l_title)
	count_label = Label.new()
	count_label.text = "2170 Cubes"
	count_label.add_theme_color_override("font_color", Color("#f5c242"))
	count_label.add_theme_font_size_override("font_size", 12)
	l_head.add_child(count_label)

	var tool_grid = GridContainer.new()
	tool_grid.columns = 2
	tool_grid.add_theme_constant_override("h_separation", 8)
	tool_grid.add_theme_constant_override("v_separation", 8)
	l_vb.add_child(tool_grid)

	var tools_meta = [
		["add", "Add Cube"], ["erase", "Erase"],
		["paint", "Paint"], ["box", "Box Fill"],
		["column", "Column"], ["eyedrop", "Eyedrop"]
	]
	for tm in tools_meta:
		var b = Button.new()
		b.text = tm[1]
		b.custom_minimum_size = Vector2(104, 48)
		_style_btn(b, tm[0] == "add")
		var tid = tm[0]
		b.pressed.connect(func(): _select_tool(tid))
		tool_grid.add_child(b)
		tool_buttons[tid] = b

	var b_hb = HBoxContainer.new()
	l_vb.add_child(b_hb)
	var b_lbl = Label.new()
	b_lbl.text = "Brush Size:"
	b_lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	b_lbl.add_theme_font_size_override("font_size", 12)
	b_hb.add_child(b_lbl)
	for sz in [1, 2, 3]:
		var sb = Button.new()
		sb.text = str(sz) + "x"
		_style_btn(sb, sz == 1)
		sb.pressed.connect(func(): _select_brush(sz))
		b_hb.add_child(sb)
		brush_buttons[sz] = sb

	var m_hb = HBoxContainer.new()
	l_vb.add_child(m_hb)
	var m_lbl = Label.new()
	m_lbl.text = "Mirror X-Axis:"
	m_lbl.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	m_lbl.add_theme_font_size_override("font_size", 12)
	m_hb.add_child(m_lbl)
	mirror_btn = Button.new()
	mirror_btn.text = "OFF"
	_style_btn(mirror_btn, false)
	mirror_btn.pressed.connect(func():
		mirror_x = !mirror_x
		mirror_btn.text = "ON" if mirror_x else "OFF"
		_style_btn(mirror_btn, mirror_x)
	)
	m_hb.add_child(mirror_btn)

	# 4. BOTTOM-LEFT CONTROLS & LIVE MINIMAP
	var ctrl_dock = PanelContainer.new()
	ctrl_dock.position = Vector2(14, 395)
	ctrl_dock.custom_minimum_size = Vector2(236, 0)
	ctrl_dock.add_theme_stylebox_override("panel", panel_style)
	canvas.add_child(ctrl_dock)
	var c_vb = VBoxContainer.new()
	ctrl_dock.add_child(c_vb)

	var ch_hb = HBoxContainer.new()
	c_vb.add_child(ch_hb)
	var c_title = Label.new()
	c_title.text = "🎮 CONTROLS"
	c_title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	c_title.add_theme_color_override("font_color", Color("#38e2ff"))
	c_title.add_theme_font_size_override("font_size", 12)
	ch_hb.add_child(c_title)
	coord_label = Label.new()
	coord_label.text = "0, 0, 0"
	coord_label.add_theme_color_override("font_color", Color("#f5c242"))
	coord_label.add_theme_font_size_override("font_size", 12)
	ch_hb.add_child(coord_label)

	for line in ["L-Click: Use Active Tool", "R-Click Drag: Orbit Camera", "Scroll: Zoom In / Out", "TAB: Play / Explore Mode"]:
		var l = Label.new()
		l.text = line
		l.add_theme_font_size_override("font_size", 11)
		l.add_theme_color_override("font_color", Color("#b8d4e8"))
		c_vb.add_child(l)

	minimap_img = Image.create(WORLD_SIZE, WORLD_SIZE, false, Image.FORMAT_RGBA8)
	minimap_tex = ImageTexture.create_from_image(minimap_img)
	var map_rect = TextureRect.new()
	map_rect.texture = minimap_tex
	map_rect.custom_minimum_size = Vector2(96, 96)
	map_rect.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	map_rect.expand_mode = TextureRect.EXPAND_FIT_WIDTH_PROPORTIONAL
	c_vb.add_child(map_rect)

	# 5. RIGHT DOCK: CUBE TEXTURE (4x2) & BIOME PALETTE (4 rows x 8 swatches)
	var right_dock = PanelContainer.new()
	right_dock.set_anchors_preset(Control.PRESET_TOP_RIGHT)
	right_dock.position = Vector2(-268, 58)
	right_dock.custom_minimum_size = Vector2(254, 0)
	right_dock.add_theme_stylebox_override("panel", panel_style)
	canvas.add_child(right_dock)

	var r_vb = VBoxContainer.new()
	r_vb.add_theme_constant_override("separation", 8)
	right_dock.add_child(r_vb)

	var th_hb = HBoxContainer.new()
	r_vb.add_child(th_hb)
	var t_title = Label.new()
	t_title.text = "CUBE TEXTURE"
	t_title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	t_title.add_theme_color_override("font_color", Color("#38e2ff"))
	t_title.add_theme_font_size_override("font_size", 13)
	th_hb.add_child(t_title)
	tex_name_label = Label.new()
	tex_name_label.text = "Grass Block"
	tex_name_label.add_theme_font_size_override("font_size", 11)
	th_hb.add_child(tex_name_label)

	var tex_grid = GridContainer.new()
	tex_grid.columns = 4
	tex_grid.add_theme_constant_override("h_separation", 6)
	tex_grid.add_theme_constant_override("v_separation", 6)
	r_vb.add_child(tex_grid)

	for ti in range(8):
		var tb = Button.new()
		tb.text = TEX_SHORT[ti]
		tb.custom_minimum_size = Vector2(54, 42)
		_style_btn(tb, ti == 0)
		var idx = ti
		tb.pressed.connect(func(): _select_texture(idx))
		tex_grid.add_child(tb)
		tex_buttons[ti] = tb

	var ph_hb = HBoxContainer.new()
	r_vb.add_child(ph_hb)
	var p_title = Label.new()
	p_title.text = "BIOME PALETTE"
	p_title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	p_title.add_theme_color_override("font_color", Color("#38e2ff"))
	p_title.add_theme_font_size_override("font_size", 13)
	ph_hb.add_child(p_title)
	hex_label = Label.new()
	hex_label.text = "#5AC54F"
	hex_label.add_theme_color_override("font_color", Color("#f5c242"))
	hex_label.add_theme_font_size_override("font_size", 12)
	ph_hb.add_child(hex_label)

	var biome_groups = [
		["Forest & Cliff", 1],
		["Frost & Crystal", 9],
		["Desert & Gold", 17],
		["Volcanic & Obsidian", 25]
	]
	for bg in biome_groups:
		var gl = Label.new()
		gl.text = bg[0]
		gl.add_theme_font_size_override("font_size", 11)
		gl.add_theme_color_override("font_color", Color("#9ab8d0"))
		r_vb.add_child(gl)

		var sw_hb = HBoxContainer.new()
		sw_hb.add_theme_constant_override("separation", 4)
		r_vb.add_child(sw_hb)
		var start_idx = bg[1]
		for offset in range(8):
			var c_idx = start_idx + offset
			var sw = Button.new()
			sw.custom_minimum_size = Vector2(25, 22)
			var col = VoxelChunkScript.PALETTE[c_idx]
			sw.add_theme_stylebox_override("normal", _make_style(col, Color("#0a1926"), 1, 3))
			sw.add_theme_stylebox_override("hover", _make_style(col, Color.WHITE, 2, 3))
			sw.add_theme_stylebox_override("pressed", _make_style(col, Color("#38e2ff"), 2, 3))
			sw.pressed.connect(func(): _select_color(c_idx))
			sw_hb.add_child(sw)

	var exp_hb = HBoxContainer.new()
	exp_hb.add_theme_constant_override("separation", 8)
	r_vb.add_child(exp_hb)
	var exp_b = Button.new()
	exp_b.text = "⬇ Export JSON"
	exp_b.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_style_btn(exp_b, false)
	exp_b.pressed.connect(save_build)
	exp_hb.add_child(exp_b)
	var imp_b = Button.new()
	imp_b.text = "⬆ Import"
	imp_b.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_style_btn(imp_b, false)
	imp_b.pressed.connect(load_build)
	exp_hb.add_child(imp_b)