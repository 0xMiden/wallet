import json
import pyatspi

results = []

def visit(node, ancestors, depth):
    if depth > 22:
        return
    try:
        role = node.getRoleName()
        name = node.name or ''
        if 'bread' in name.lower():
            state = node.getState()
            try:
                rect = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
                bounds = [rect.x, rect.y, rect.width, rect.height]
            except Exception:
                bounds = None
            results.append({'role': role, 'name': name, 'ancestors': ancestors[-8:], 'showing': state.contains(pyatspi.STATE_SHOWING), 'bounds': bounds})
        for child in node:
            visit(child, ancestors + [role], depth + 1)
    except Exception:
        pass

visit(pyatspi.Registry.getDesktop(0), [], 0)
print(json.dumps(results))
