extends Camera3D

var selected_block_id = 1
@onready var world = get_parent()

func _ready():
	position = Vector3(16, 22, 38)
	look_at(Vector3(16, 6, 16), Vector3.UP)

func _process(delta):
	var input_dir = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	if input_dir != Vector2.ZERO:
		position += (global_transform.basis * Vector3(input_dir.x, 0, input_dir.y)) * 18.0 * delta

func _unhandled_input(event):
	if event is InputEventKey and event.pressed:
		if event.keycode >= KEY_1 and event.keycode <= KEY_5:
			selected_block_id = event.keycode - KEY_0

	if event is InputEventMouseButton and event.pressed:
		if event.button_index == MOUSE_BUTTON_LEFT:
			_raycast_edit(event.position, false)
		elif event.button_index == MOUSE_BUTTON_RIGHT:
			_raycast_edit(event.position, true)

func _raycast_edit(screen_pos: Vector2, is_placing: bool):
	var from = project_ray_origin(screen_pos)
	var to = from + project_ray_normal(screen_pos) * 150.0
	var query = PhysicsRayQueryParameters3D.create(from, to)
	var hit = get_world_3d().direct_space_state.intersect_ray(query)
	
	if hit:
		var offset = hit.normal * 0.5 if is_placing else -hit.normal * 0.5
		var target_pos = (hit.position + offset).floor()
		world.set_world_voxel(int(target_pos.x), int(target_pos.y), int(target_pos.z), selected_block_id if is_placing else 0)