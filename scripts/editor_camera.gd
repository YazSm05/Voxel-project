extends Camera3D

var yaw: float = 0.78 # Isometric 45-degree angle
var pitch: float = -0.55
var distance: float = 38.0
var target: Vector3 = Vector3(16, 9, 16)
var is_orbiting: bool = false

@onready var world = get_parent()

func _ready():
	_update_orbit_transform()

func _process(delta):
	var input_dir = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	if input_dir != Vector2.ZERO:
		yaw -= input_dir.x * 1.8 * delta
		pitch = clamp(pitch - input_dir.y * 1.2 * delta, -1.4, -0.1)
		_update_orbit_transform()

func _update_orbit_transform():
	var offset = Vector3(
		cos(pitch) * sin(yaw),
		-sin(pitch),
		cos(pitch) * cos(yaw)
	) * distance
	position = target + offset
	look_at(target, Vector3.UP)

func _unhandled_input(event):
	if event is InputEventKey and event.pressed:
		if event.keycode >= KEY_1 and event.keycode <= KEY_8:
			world.selected_block_id = event.keycode - KEY_0

	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_RIGHT:
			is_orbiting = event.pressed
		elif event.button_index == MOUSE_BUTTON_WHEEL_UP and event.pressed:
			distance = clamp(distance - 2.5, 10.0, 80.0)
			_update_orbit_transform()
		elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN and event.pressed:
			distance = clamp(distance + 2.5, 10.0, 80.0)
			_update_orbit_transform()
		elif event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
			_raycast_tool(event.position)

	if event is InputEventMouseMotion and is_orbiting:
		yaw -= event.relative.x * 0.008
		pitch = clamp(pitch - event.relative.y * 0.008, -1.4, -0.1)
		_update_orbit_transform()

func _raycast_tool(screen_pos: Vector2):
	var from = project_ray_origin(screen_pos)
	var to = from + project_ray_normal(screen_pos) * 150.0
	var query = PhysicsRayQueryParameters3D.create(from, to)
	var hit = get_world_3d().direct_space_state.intersect_ray(query)
	
	if hit:
		world.apply_tool_at(hit.position.x, hit.position.y, hit.position.z, hit.normal)