import json
import time
import pyatspi


def find_button(node, toolbar=False, depth=0):
    if depth > 40:
        return None
    try:
        toolbar = toolbar or node.getRole() == pyatspi.ROLE_TOOL_BAR
        state = node.getState()
        if toolbar and node.name == 'Bread' and node.getRole() == pyatspi.ROLE_PUSH_BUTTON and state.contains(pyatspi.STATE_SHOWING):
            box = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
            if box.width > 0 and box.height > 0:
                return [box.x + box.width // 2, box.y + box.height // 2]
        for child in node:
            if child is not None:
                found = find_button(child, toolbar, depth + 1)
                if found:
                    return found
    except Exception:
        return None
    return None


end = time.monotonic() + 10
while time.monotonic() < end:
    found = find_button(pyatspi.Registry.getDesktop(0))
    if found:
        print(json.dumps(found))
        break
    time.sleep(0.1)
else:
    raise RuntimeError('Visible native Bread toolbar button unavailable')
