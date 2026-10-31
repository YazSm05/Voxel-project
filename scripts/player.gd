extends CharacterBody3D

const SPEED = 8.0
const JUMP_VELOCITY = 7.2
var gravity = ProjectSettings.get_setting("physics/3d/default_gravity")
var is_dragging_look = false

@onready var cam: Camera3D = $Camera3D

func _unhandled_input(event):
	if not is_physics_processing():
		return

	# Click inside the game window in WebGL to capture mouse pointer
	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_LEFT or event.button_index == MOUSE_BUTTON_RIGHT:
			is_dragging_look = event.pressed
			if event.pressed and Input.mouse_mode != Input.MOUSE_MODE_CAPTURED:
				Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
	
	if event is InputEventKey and event.pressed and event.keycode == KEY_ESCAPE:
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE

	# Rotate camera on mouse movement (works both when captured OR while dragging)
	if event is InputEventMouseMotion:
		if Input.mouse_mode == Input.MOUSE_MODE_CAPTURED or is_dragging_look:
			rotate_y(-event.relative.x * 0.004)
			cam.rotate_x(-event.relative.y * 0.004)
			cam.rotation.x = clamp(cam.rotation.x, deg_to_rad(-80), deg_to_rad(80))

func _physics_process(delta):
	if not is_on_floor():
		velocity.y -= gravity * delta
	if Input.is_key_pressed(KEY_SPACE) and is_on_floor():
		velocity.y = JUMP_VELOCITY

	# Keyboard camera rotation fallback (Q/E or PageUp/PageDown)
	if Input.is_key_pressed(KEY_E):
		rotate_y(-2.2 * delta)
	if Input.is_key_pressed(KEY_R):
		rotate_y(2.2 * delta)

	# Forward/Backward & Strafe (Arrow keys + WASD / ZQSD compatible)
	var move_x = 0.0
	var move_z = 0.0
	if Input.is_key_pressed(KEY_UP) or Input.is_key_pressed(KEY_W) or Input.is_key_pressed(KEY_Z):
		move_z -= 1.0
	if Input.is_key_pressed(KEY_DOWN) or Input.is_key_pressed(KEY_S):
		move_z += 1.0
	if Input.is_key_pressed(KEY_LEFT) or Input.is_key_pressed(KEY_A) or Input.is_key_pressed(KEY_Q):
		move_x -= 1.0
	if Input.is_key_pressed(KEY_RIGHT) or Input.is_key_pressed(KEY_D):
		move_x += 1.0

	var direction = (transform.basis * Vector3(move_x, 0, move_z)).normalized()
	if direction != Vector3.ZERO:
		velocity.x = direction.x * SPEED
		velocity.z = direction.z * SPEED
	else:
		velocity.x = move_toward(velocity.x, 0, SPEED)
		velocity.z = move_toward(velocity.z, 0, SPEED)

	move_and_slide()
	
	# Respawn if player falls off the floating island
	if global_position.y < -15.0:
		global_position = Vector3(16, 20, 16)
		velocity = Vector3.ZERO