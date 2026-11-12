"""Bounded native capsule input over the existing idb companion, without app lifecycle changes."""
import argparse
import asyncio
from dataclasses import fields
from importlib.metadata import version
import inspect
import json
import math
import shutil
import signal
import sys
import time

from idb.common.types import (
    AccessibilityInfoOptions, AppProcessState, HIDDirection, HIDPress, HIDTouch, Point,
)
from idb.grpc.client import Client
from idb.grpc.management import ClientManager


def compatibility():
    expected = [(Point, {'x', 'y'}), (HIDTouch, {'point'}),
                (HIDPress, {'action', 'direction'})]
    for cls, names in expected:
        if not names <= {field.name for field in fields(cls)}:
            raise ValueError('installed idb HID event shape is unsupported')
    for method, parameter in [(Client.hid, 'event_iterator'),
                              (ClientManager.from_udid, 'udid'),
                              (Client.accessibility_info, 'options')]:
        if parameter not in inspect.signature(method).parameters:
            raise ValueError('installed idb client API is unsupported')
    return {'fbIdbVersion': version('fb-idb'), 'hidApi': 'Client.hid(AsyncIterable[HIDEvent])',
            'touchModel': 'HIDPress(HIDTouch(Point), DOWN samples then one UP)'}


def number(value, minimum, maximum):
    if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError('native input coordinate or bound is invalid')
    return value


def path_points(request, width, height):
    number(width, 1, 4096)
    number(height, 1, 4096)
    vertices = request.get('points')
    steps = request.get('steps')
    delay_ms = request.get('delayMs')
    if not isinstance(vertices, list) or not 2 <= len(vertices) <= 4:
        raise ValueError('native path requires two to four vertices')
    if type(steps) is not int or not 10 <= steps <= 40:
        raise ValueError('native path steps are outside the bounded range')
    number(delay_ms, 20, 60)
    if (len(vertices) - 1) * steps * delay_ms > 8000:
        raise ValueError('native path duration exceeds eight seconds')
    coordinates = []
    for vertex in vertices:
        if not isinstance(vertex, dict) or set(vertex) != {'x', 'y'}:
            raise ValueError('native path vertex must have exactly x and y')
        coordinates.append(Point(number(vertex['x'], 0, width - 1), number(vertex['y'], 0, height - 1)))
    if len(set(coordinates)) == 1:
        raise ValueError('native path must move')
    points = [coordinates[0]]
    for start, end in zip(coordinates, coordinates[1:]):
        points.extend(Point(start.x + (end.x - start.x) * index / steps,
                            start.y + (end.y - start.y) * index / steps)
                      for index in range(1, steps + 1))
    return points, delay_ms / 1000


def events_for(points):
    return [HIDPress(action=HIDTouch(point=point), direction=HIDDirection.DOWN)
            for point in points] + [HIDPress(action=HIDTouch(point=points[-1]), direction=HIDDirection.UP)]


def emit(value):
    print(json.dumps(value), flush=True)


async def app_state(client, bundle):
    matches = [app for app in await client.list_apps(fetch_process_state=True) if app.bundle_id == bundle]
    if len(matches) != 1 or matches[0].process_state != AppProcessState.RUNNING or matches[0].process_id <= 0:
        raise ValueError('the original wallet process must already be running')
    return matches[0].process_id


async def run(args, request):
    api = compatibility()
    manager = ClientManager(companion_path=shutil.which('idb_companion'))
    async with manager.from_udid(args.udid) as client:
        pid = await app_state(client, args.bundle)
        target = await client.describe()
        screen = target.screen_dimensions
        if screen is None or screen.width_points is None or screen.height_points is None:
            raise ValueError('idb must report the actual simulator point dimensions')
        state = {**api, 'pid': pid, 'width': screen.width_points, 'height': screen.height_points,
                 'osVersion': target.os_version, 'phase': 'done'}
        if args.op == 'state':
            emit(state)
            return
        label = request.get('label')
        if not isinstance(label, str) or not 1 <= len(label) <= 100:
            raise ValueError('native capsule requires a bounded accessibility label')
        info = await client.accessibility_info(target=None, options=AccessibilityInfoOptions())
        tree = json.loads(info.json)
        if not isinstance(tree, list):
            raise ValueError('unsupported idb accessibility tree shape')
        capsules = [row for row in tree if row.get('type') == 'Button'
                    and row.get('AXLabel') == label and isinstance(row.get('frame'), dict)]
        if len(capsules) != 1:
            raise ValueError('exactly one real native capsule must be accessible in the foreground')
        frame = capsules[0]['frame']
        for key in ['x', 'y', 'width', 'height']:
            number(frame.get(key), 0, max(screen.width_points, screen.height_points))
        if frame['width'] <= 0 or frame['height'] <= 0:
            raise ValueError('native capsule has no visible area')
        state['capsule'] = frame
        if args.op == 'bounds':
            emit(state)
            return
        if request.get('expectedPid') != pid:
            raise ValueError('the wallet process changed before input')
        points, delay = path_points(request, screen.width_points, screen.height_points)
        start = points[0]
        if not (frame['x'] <= start.x <= frame['x'] + frame['width']
                and frame['y'] <= start.y <= frame['y'] + frame['height']):
            raise ValueError('native capsule path must begin inside its actual AX frame')
        events = events_for(points)
        released = False
        async def stream():
            nonlocal released
            for index, event in enumerate(events):
                if index == len(events) - 1:
                    emit({'phase': 'releasing', 'beforeUpMs': time.time_ns() / 1_000_000})
                yield event
                if index == 0:
                    emit({'phase': 'started', 'afterFirstDownMs': time.time_ns() / 1_000_000})
                if index < len(events) - 1:
                    await asyncio.sleep(delay)
            released = True
        try:
            await client.hid(stream())
        finally:
            if not released:
                # Failure cleanup releases this contact only; it never restarts the app or companion.
                await asyncio.shield(asyncio.wait_for(client.send_events([events[-1]]), timeout=2))
        if await app_state(client, args.bundle) != pid:
            raise ValueError('native input must not replace the wallet process')
        emit({**state, 'phase': 'done', 'downSamples': len(points), 'upSamples': 1,
              'durationLimitMs': 8000, 'requestedDelayMs': delay * 1000})


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--udid', required=True)
    parser.add_argument('--bundle', required=True)
    parser.add_argument('--op', choices=['state', 'bounds', 'path'], required=True)
    args = parser.parse_args()
    raw = sys.stdin.read(16385)
    if len(raw) > 16384:
        raise ValueError('native input request exceeds the bounded size')
    request = json.loads(raw)
    if not isinstance(request, dict):
        raise ValueError('native input requires an object')
    task = asyncio.current_task()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
    await asyncio.wait_for(run(args, request), timeout=35)


if __name__ == '__main__':
    asyncio.run(main())
