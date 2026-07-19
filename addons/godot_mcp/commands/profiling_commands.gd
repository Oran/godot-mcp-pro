@tool
extends "res://addons/godot_mcp/commands/base_command.gd"


func get_commands() -> Dictionary:
	return {
		"get_performance_monitors": _get_performance_monitors,
		"get_editor_performance": _get_editor_performance,
	}


func _get_performance_monitors(params: Dictionary) -> Dictionary:
	# Performance is a per-process singleton: reading it here would report the
	# EDITOR's metrics, not the game's. Route through the game IPC channel.
	if get_editor().is_playing_scene():
		var game_result := await send_game_command("get_performance_monitors", {}, 5.0)
		if game_result.has("error"):
			return game_result
		var payload := unwrap_game_result(game_result)
		var game_monitors: Dictionary = payload.get("monitors", {})
		var category: String = optional_string(params, "category", "")
		if not category.is_empty():
			var filtered := {}
			for key: String in game_monitors:
				if key.begins_with(category):
					filtered[key] = game_monitors[key]
			return success({"monitors": filtered, "category": category, "process": "game"})
		return success({"monitors": game_monitors, "process": "game"})

	return error(-32000, "No scene is currently playing", {
		"suggestion": "Use play_scene first. For editor-process metrics, use get_editor_performance.",
	})


func _get_editor_performance(params: Dictionary) -> Dictionary:
	# Quick summary for common use
	var summary := {
		"fps": Performance.get_monitor(Performance.TIME_FPS),
		"frame_time_msec": Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0,
		"draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
		"objects_in_frame": Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME),
		"node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
		"orphan_nodes": Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT),
		"memory_static_mb": Performance.get_monitor(Performance.MEMORY_STATIC) / (1024.0 * 1024.0),
		"video_mem_mb": Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED) / (1024.0 * 1024.0),
	}
	return success(summary)
