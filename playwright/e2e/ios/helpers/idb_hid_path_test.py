"""Pure input shape/API checks using the installed idb types, without a companion or app."""
import math
import unittest

from idb.common.types import HIDDirection, HIDPress, HIDTouch, Point
from idb_hid_path import compatibility, events_for, path_points


class NativeHidPathTests(unittest.TestCase):
    def request(self):
        return {'points': [{'x': 30, 'y': 50}, {'x': 30, 'y': 400}, {'x': 30, 'y': 50}],
                'steps': 30, 'delayMs': 40}

    def test_installed_idb_contract_is_present(self):
        self.assertTrue(compatibility()['fbIdbVersion'])

    def test_reversal_keeps_one_contact_then_one_final_up(self):
        points, delay = path_points(self.request(), 393, 852)
        events = events_for(points)
        self.assertEqual(len(points), 61)
        self.assertEqual(delay, 0.04)
        self.assertEqual(points[0], points[-1])
        self.assertEqual(points[30], Point(30, 400))
        self.assertTrue(all(isinstance(event, HIDPress) and isinstance(event.action, HIDTouch) for event in events))
        self.assertTrue(all(event.direction == HIDDirection.DOWN for event in events[:-1]))
        self.assertEqual(events[-1].direction, HIDDirection.UP)
        self.assertEqual(events[-1].action.point, points[-1])

    def test_hold_segment_does_not_lift_the_finger(self):
        request = self.request()
        request['points'][-1] = {'x': 30, 'y': 400}
        points, _ = path_points(request, 393, 852)
        self.assertEqual(points[30:], [Point(30, 400)] * 31)
        self.assertEqual(sum(event.direction == HIDDirection.UP for event in events_for(points)), 1)

    def test_invalid_coordinates_do_not_produce_input(self):
        for coordinate in [-1, 393, math.inf, math.nan, True, '30']:
            with self.subTest(coordinate=coordinate):
                request = self.request()
                request['points'][0]['x'] = coordinate
                with self.assertRaises(ValueError):
                    path_points(request, 393, 852)

    def test_invalid_path_bounds_do_not_produce_input(self):
        for value in [0, 41, True, 30.5]:
            request = self.request()
            request['steps'] = value
            with self.assertRaises(ValueError):
                path_points(request, 393, 852)
        for points in [[], [{'x': 1, 'y': 1}], [{'x': 1, 'y': 1}] * 5, [{'x': 1, 'y': 1}] * 2]:
            request = self.request()
            request['points'] = points
            with self.assertRaises(ValueError):
                path_points(request, 393, 852)
        request = self.request()
        request.update(points=request['points'] + [{'x': 30, 'y': 400}], steps=40, delayMs=60)
        self.assertEqual(len(path_points(request, 393, 852)[0]), 121)
        request['delayMs'] = 61
        with self.assertRaises(ValueError):
            path_points(request, 393, 852)


if __name__ == '__main__':
    unittest.main()
