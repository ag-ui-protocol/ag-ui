port ENV.fetch("PORT", 4000)
threads_count = Integer(ENV.fetch("RAILS_MAX_THREADS", 5))
threads threads_count, threads_count

environment ENV.fetch("RACK_ENV", "development")

preload_app!
