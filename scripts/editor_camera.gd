extends Camera3D

var yaw: float = 0.785 # 45 degrees isometric
var pitch: float = -0.58
var distance: float = 42.0
var target: Vector3 = Vector3(16, 9, 16)
var is_orbiting: bool = false

@onready var world = get_parent()

func _ready():
	projection = Camera3D.PROJECTION_ORTHOGONAL
	size = 28.0
	_update_orbit_transform()

func toggle_ortho():
	if projection == Camera3D.PROJECTION_ORTHOGONAL:
		projection = Camera3D.PROJECTION_PERSPECTIVE
	else:
		projection = Camera3D.PROJECTION_ORTHOGONAL
		size = distance * 0.68
	_update_orbit_transform()

func set_angle(new_yaw: float, new_pitch: float):
	yaw = new_yaw
	pitch = new_pitch
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
	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_RIGHT:
			is_orbiting = event.pressed
		elif event.button_index == MOUSE_BUTTON_WHEEL_UP and event.pressed:
			distance = clamp(distance - 2.5, 12.0, 75.0)
			size = distance * 0.68
			_update_orbit_transform()
		elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN and event.pressed:
			distance = clamp(distance + 2.5, 12.0, 75.0)
			size = distance * 0.68
			_update_orbit_transform()
		elif event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
			_raycast_tool(event.position)

	if event is InputEventMouseMotion and is_orbiting:
		yaw -= event.relative.x * 0.008
		pitch = clamp(pitch - event.relative.y * 0.008, -1.4, -0.1)
		_update_orbit_transform()

func _raycast_tool(screen_pos: Vector2):
	var from = project_ray_origin(screen_pos)
	var to = from + project_ray_normal(screen_pos) * 200.0
	var query = PhysicsRayQueryParameters3D.create(from, to)
	var hit = get_world_3d().direct_space_state.intersect_ray(query)
	
	if hit:
		world.apply_tool_at(hit.position, hit.normal)