"""
rc_driver.py - Main entry point for the AutoRCCar autonomous driving system.

Handles multi-threaded network server setup for video stream and sensor data,
neural network prediction, object detection, distance measurement,
and RC car control decisions.
"""

import socketserver
import threading
import socket
import cv2
import numpy as np
import time

from .model import NeuralNetwork, load_data
from .rc_driver_helper import RCControl, DistanceToCamera, ObjectDetection


class Server:
    """Multi-threaded network server for video stream and sensor data.

    Manages two TCP server threads:
      - VideoStreamHandler  on port1 (default 8000)
      - SensorDataHandler   on port2 (default 8002)
    """

    def __init__(self, host, port1, port2):
        """Initialise the server with host and port configuration.

        Args:
            host (str): Server host address, e.g. '192.168.1.100'.
            port1 (int): Video stream server port (default 8000).
            port2 (int): Sensor data server port (default 8002).
        """
        self.host = host
        self.port1 = port1
        self.port2 = port2

        self.sensor_data = None

        # Video stream TCP server
        self.video_server = socketserver.TCPServer(
            (self.host, self.port1), VideoStreamHandler
        )
        self.video_server.allow_reuse_address = True

        # Sensor data TCP server
        self.sensor_server = socketserver.TCPServer(
            (self.host, self.port2), SensorDataHandler
        )
        self.sensor_server.allow_reuse_address = True

    def start(self):
        """Start both server threads and begin autonomous driving."""
        # Start video stream server in a daemon thread
        video_thread = threading.Thread(target=self.video_server.serve_forever)
        video_thread.daemon = True
        video_thread.start()
        print(f"Video stream server started on {self.host}:{self.port1}")

        # Start sensor data server in a daemon thread
        sensor_thread = threading.Thread(target=self.sensor_server.serve_forever)
        sensor_thread.daemon = True
        sensor_thread.start()
        print(f"Sensor data server started on {self.host}:{self.port2}")

        # Keep main thread alive
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("Shutting down servers...")
            self.video_server.shutdown()
            self.sensor_server.shutdown()


class SensorDataHandler(socketserver.BaseRequestHandler):
    """Handle incoming ultrasonic sensor data from the Raspberry Pi client.

    Receives distance measurements via TCP and stores the latest
    reading for the autonomous driving decision loop.
    """

    def handle(self):
        """Process a single sensor data connection."""
        data = self.request.recv(1024)
        if data:
            sensor_val = data.decode().strip()
            try:
                VideoStreamHandler.latest_sensor_data = int(sensor_val)
            except ValueError:
                pass
            print(f"Sensor data received: {sensor_val}")


class VideoStreamHandler(socketserver.StreamRequestHandler):
    """Handle incoming video stream frames and execute autonomous driving.

    Processes JPEG-encoded video frames from the Raspberry Pi camera,
    performs object detection (stop signs, traffic lights), calculates
    distances, runs neural network predictions, and controls the RC car.

    Class-level attribute for cross-handler sensor data sharing:
        latest_sensor_data (int): Most recent ultrasonic distance reading.
    """

    latest_sensor_data = None

    # Object height parameters (manually measured, in cm)
    h1 = 5.5    # Stop sign height (cm)
    h2 = 5.5    # Traffic light height (cm)

    # Distance threshold configuration
    d_sensor_thresh = 30         # Ultrasonic sensor stop threshold (cm)
    d_stop_light_thresh = 25     # Stop sign / traffic light stop threshold (cm)

    # Time control parameters
    stop_start = 0               # Stop start time (cv2.getTickCount)
    stop_finish = 0              # Stop finish time
    stop_time = 0                # Stop duration (seconds)
    drive_time_after_stop = 0    # Driving time after stop (seconds)

    def handle(self):
        """Process the video stream and make autonomous driving decisions."""
        print("VideoStreamHandler connected, starting frame processing...")

        # --- Initialise neural network ---
        nn = NeuralNetwork()
        nn.create(np.int32([76800, 32, 4]))
        try:
            nn.load_model("saved_model/nn_model.xml")
            print("Loaded trained neural network model.")
        except Exception:
            print("No saved model found. Using untrained network.")

        # --- Initialise RC car control ---
        serial_port = "/dev/tty.usbmodem1421"
        try:
            rc_car = RCControl(serial_port)
            print("RC car connected.")
        except Exception:
            print("Warning: Could not connect to RC car serial port.")
            rc_car = None

        # --- Initialise helper classes ---
        d_to_camera = DistanceToCamera()
        obj_detection = ObjectDetection()

        # --- Load cascade classifiers ---
        stop_cascade = cv2.CascadeClassifier("cascade_xml/stop_sign.xml")
        light_cascade = cv2.CascadeClassifier("cascade_xml/traffic_light.xml")

        # --- State variables ---
        sensor_data = None
        stop_flag = False
        stop_sign_active = False
        d_stop_sign = self.d_stop_light_thresh
        d_light = self.d_stop_light_thresh

        stream_bytes = b""

        while True:
            # Read stream data
            try:
                data = self.rfile.read(1024)
                if not data:
                    break
                stream_bytes += data
            except (ConnectionResetError, BrokenPipeError):
                print("Client disconnected.")
                break

            # Extract complete JPEG frames
            first = stream_bytes.find(b'\xff\xd8')
            last = stream_bytes.find(b'\xff\xd9')

            if first != -1 and last != -1:
                jpg = stream_bytes[first:last + 2]
                stream_bytes = stream_bytes[last + 2:]

                # Decode JPEG frames
                try:
                    gray = cv2.imdecode(
                        np.frombuffer(jpg, dtype=np.uint8), cv2.IMREAD_GRAYSCALE
                    )
                    image = cv2.imdecode(
                        np.frombuffer(jpg, dtype=np.uint8), cv2.IMREAD_COLOR
                    )
                except Exception:
                    continue

                if gray is None or image is None:
                    continue

                # Extract lower half of the image (ROI for driving)
                height, width = gray.shape
                roi = gray[int(height / 2):height, :]

                # Display frame
                cv2.imshow('AutoRCCar', image)
                if cv2.waitKey(1) & 0xFF in (ord('q'), ord('x')):
                    print("Quit requested by user.")
                    break

                # Reshape ROI for neural network input
                image_array = roi.reshape(
                    1, int(height / 2) * width
                ).astype(np.float32)

                # --- Object detection ---
                v_param1 = obj_detection.detect(stop_cascade, gray, image)
                v_param2 = obj_detection.detect(light_cascade, gray, image)

                # --- Distance measurement ---
                if v_param1 > 0 or v_param2 > 0:
                    d1 = d_to_camera.calculate(v_param1, self.h1, 300, image)
                    d2 = d_to_camera.calculate(v_param2, self.h2, 100, image)
                    d_stop_sign = d1
                    d_light = d2

                # --- Neural network prediction ---
                try:
                    prediction = nn.predict(image_array)
                except Exception:
                    continue

                # --- Autonomous driving decision logic ---
                # Update latest sensor data from class attribute
                sensor_data = VideoStreamHandler.latest_sensor_data

                # Condition 1: Ultrasonic obstacle detection
                if sensor_data is not None and int(sensor_data) < self.d_sensor_thresh:
                    print("Stop, obstacle in front")
                    if rc_car:
                        rc_car.stop()
                    sensor_data = None

                # Condition 2: Stop sign within threshold
                elif (0 < d_stop_sign < self.d_stop_light_thresh
                      and stop_sign_active):
                    print("Stop sign ahead")
                    if rc_car:
                        rc_car.stop()

                    if stop_flag is False:
                        self.stop_start = cv2.getTickCount()
                        stop_flag = True
                    self.stop_finish = cv2.getTickCount()

                    self.stop_time = (self.stop_finish - self.stop_start) / \
                                     cv2.getTickFrequency()
                    print("Stop time: %.2fs" % self.stop_time)

                    if self.stop_time > 5:
                        print("Waited for 5 seconds")
                        stop_flag = False
                        stop_sign_active = False

                # Condition 3: Traffic light detection
                elif 0 < d_light < self.d_stop_light_thresh:
                    if obj_detection.red_light:
                        print("Red light")
                        if rc_car:
                            rc_car.stop()
                    elif obj_detection.green_light:
                        print("Green light")
                    elif obj_detection.yellow_light:
                        print("Yellow light flashing")

                    d_light = self.d_stop_light_thresh
                    obj_detection.red_light = False
                    obj_detection.green_light = False
                    obj_detection.yellow_light = False

                # Condition 4: Normal driving
                else:
                    if rc_car:
                        rc_car.steer(prediction[0] if isinstance(prediction, np.ndarray) and prediction.size > 0 else prediction)
                    self.stop_start = cv2.getTickCount()
                    d_stop_sign = self.d_stop_light_thresh

        cv2.destroyAllWindows()
        print("VideoStreamHandler shutting down.")


if __name__ == '__main__':
    host, port1, port2 = "192.168.1.100", 8000, 8002

    server = Server(host, port1, port2)
    server.start()
